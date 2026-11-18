#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function args() {
  const result = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    result[process.argv[index].replace(/^--/, '')] = process.argv[index + 1]
  }
  if (!result.archive || !result.version) throw new Error('Usage: node tests/installer-regression.mjs --archive <file> --version <version>')
  result.platform = process.platform === 'win32' ? 'win' : 'linux'
  return result
}

// Async on purpose: while an installer child process runs, the in-process localhost
// release stub must keep answering requests; spawnSync would freeze the event loop and
// deadlock every resolution case until its timeout.
function invoke(command, commandArgs, options = {}) {
  // Node refuses to spawn .cmd/.bat files without a shell since the CVE-2024-27980 fix,
  // and shell:true misjoins arguments (it breaks paths containing spaces), so route them
  // through cmd.exe with explicit quoting; the outer quote pair lets /s /c strip cleanly.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`
    const cmdline = `"${[quote(command), ...commandArgs.map(quote)].join(' ')}"`
    command = process.env.ComSpec || 'cmd.exe'
    commandArgs = ['/d', '/s', '/c', cmdline]
    options = { ...options, windowsVerbatimArguments: true }
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr, output: `${stdout}${stderr}` })
    })
  })
}

function assertSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}):\n${result.output}`)
  console.log(`PASS: ${label}`)
}

function assertFailure(result, label, expectedText) {
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded\n${result.output}`)
  if (expectedText && !result.output.toLowerCase().includes(expectedText.toLowerCase())) {
    throw new Error(`${label} did not report ${JSON.stringify(expectedText)}\n${result.output}`)
  }
  console.log(`PASS: ${label} (rejected with a non-zero exit)`)
}

function installerInvocation(root, platform, installerArgs) {
  if (platform === 'win') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'install.ps1'), ...installerArgs]]
  }
  return ['sh', [join(root, 'install.sh'), ...installerArgs]]
}

async function main() {
  const options = args()
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const archive = resolve(options.archive)
  const temp = mkdtempSync(join(tmpdir(), 'dsh-installer-regression-'))
  const platform = options.platform
  const versionFlag = platform === 'win' ? '-Version' : '--version'
  const archiveFlag = platform === 'win' ? '-Archive' : '--archive'
  const prefixFlag = platform === 'win' ? '-Prefix' : '--prefix'
  const checksumFlag = platform === 'win' ? '-Checksum' : '--checksum'
  const noPathFlag = platform === 'win' ? '-NoModifyPath' : '--no-modify-path'
  const runInstaller = async (installerArgs, env = process.env) => {
    const [command, commandArgs] = installerInvocation(root, platform, installerArgs)
    return invoke(command, commandArgs, { env })
  }
  // Version resolution must skip dev/alpha prereleases, order candidates by semver, and
  // probe the download base for availability: the index can be fresher than the mirror.
  // The stub serves the static releases.json shape published with every release;
  // --releases-json-url points straight at it (explicit URLs are never proxied), while the
  // --github-proxy flag points at the same stub, so probe and download requests must
  // arrive rewritten as "<proxy>/https://github.com/..."; the archive download then 404s
  // on purpose, so every run must fail while still having logged which version it resolved.
  const exerciseResolution = async (jsonFlag, proxyFlag, env) => {
    const releaseTags = ['v2.0.0-alpha.1', 'v2.0.0-dev.3', 'v1.0.1-rc.1', 'v1.0.0', 'v0.3.0-beta.1', 'v0.2.9', 'not-a-semver']
    const index = {
      schemaVersion: 1,
      repository: 'example/project',
      generatedAt: '2026-01-01T00:00:00Z',
      versions: releaseTags.map((tag) => tag.replace(/^v(?=\d)/, '')),
      releases: releaseTags.map((tag) => ({
        version: tag.replace(/^v(?=\d)/, ''),
        tag,
        prerelease: tag.includes('-'),
        publishedAt: '2026-01-01T00:00:00Z',
        url: `https://github.com/example/project/releases/tag/${tag}`,
      })),
    }
    const requestedPaths = []
    let missingProbes = new Set()
    const apiServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      requestedPaths.push(url.pathname)
      if (url.pathname === '/releases.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(index))
        return
      }
      const probe = /^\/https:\/\/github\.com\/.*\/dsh-v(.+)-(linux|win)-x64\.(?:tar\.gz|zip)\.sha256$/.exec(url.pathname)
      if (probe) {
        const missing = missingProbes.has(probe[1])
        res.writeHead(missing ? 404 : 200, { 'content-type': 'text/plain' })
        res.end(missing ? 'not found' : 'ok')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    await new Promise((listen) => apiServer.listen(0, '127.0.0.1', listen))
    try {
      const apiPort = apiServer.address().port
      const runCase = async (label, missing, expectedText) => {
        requestedPaths.length = 0
        missingProbes = new Set(missing)
        const resolvedPrefix = join(temp, `resolved-prefix-${platform}-${label}`)
        const resolutionResult = await runInstaller([
          jsonFlag, `http://127.0.0.1:${apiPort}/releases.json`,
          proxyFlag, `http://127.0.0.1:${apiPort}`,
          prefixFlag, resolvedPrefix, noPathFlag,
        ], env)
        assertFailure(resolutionResult, label, expectedText)
        if (existsSync(resolvedPrefix)) throw new Error(`${label} created the installation prefix`)
      }
      const probePathsFor = (version) => requestedPaths.filter((p) => p.endsWith('.sha256') && p.includes(`dsh-v${version}-`))

      // Newest indexed version is already mirrored: exactly one probe, then the download.
      await runCase('resolution-excludes-dev-alpha', [], 'resolved dsh version: 1.0.1-rc.1')
      if (!requestedPaths.includes('/releases.json')) {
        throw new Error(`release index JSON was not fetched directly: ${JSON.stringify(requestedPaths)}`)
      }
      if (probePathsFor('1.0.1-rc.1').length !== 1) {
        throw new Error(`expected exactly one availability probe for 1.0.1-rc.1: ${JSON.stringify(requestedPaths)}`)
      }
      for (const skipped of ['2.0.0-alpha.1', '2.0.0-dev.3', '1.0.0', '0.3.0-beta.1', '0.2.9']) {
        if (probePathsFor(skipped).length !== 0) {
          throw new Error(`unexpected availability probe for ${skipped}: ${JSON.stringify(requestedPaths)}`)
        }
      }
      if (!requestedPaths.some((p) => p.startsWith('/https://github.com/') && !p.endsWith('.sha256'))) {
        throw new Error(`release download was not rewritten through the proxy: ${JSON.stringify(requestedPaths)}`)
      }
      console.log('PASS: release index JSON fetched directly, newest release probed once, download rewritten through the GitHub proxy')

      // Mirror lag: the newest version is indexed but not synced yet, so resolution must
      // fall back to the newest version that actually exists at the download base.
      await runCase('resolution-falls-back-when-mirror-lags', ['1.0.1-rc.1'], 'resolved dsh version: 1.0.0')
      const lagProbes = requestedPaths.filter((p) => p.endsWith('.sha256'))
      if (lagProbes.length !== 2 || !lagProbes[0].includes('dsh-v1.0.1-rc.1-') || !lagProbes[1].includes('dsh-v1.0.0-')) {
        throw new Error(`expected probes in descending order 1.0.1-rc.1 then 1.0.0: ${JSON.stringify(lagProbes)}`)
      }
      console.log('PASS: resolution falls back to the newest version available at the mirror')

      // Nothing indexed is downloadable: hard failure naming both sources.
      await runCase('resolution-fails-when-mirror-is-empty', ['1.0.1-rc.1', '1.0.0', '0.3.0-beta.1', '0.2.9'], 'no release listed in')
      console.log('PASS: empty mirror fails loudly instead of installing nothing')
    } finally {
      await new Promise((close) => apiServer.close(close))
    }
  }
  try {
    const isolated = join(temp, 'isolated')
    const isolatedArchive = join(isolated, basename(archive))
    mkdirSync(isolated, { recursive: true })
    copyFileSync(archive, isolatedArchive)
    const noChecksumPrefix = join(temp, 'no-checksum-prefix')
    let result = await runInstaller([versionFlag, options.version, archiveFlag, isolatedArchive, prefixFlag, noChecksumPrefix, noPathFlag])
    assertSuccess(result, 'local archive without a checksum installs with verification skipped')
    if (!result.output.toLowerCase().includes('skipping')) {
      throw new Error(`Checksum skip was not reported\n${result.output}`)
    }
    if (!existsSync(join(noChecksumPrefix, 'bin'))) throw new Error('Checksum-less install did not create the installation prefix')

    const corruptArchive = join(temp, basename(archive))
    copyFileSync(archive, corruptArchive)
    writeFileSync(corruptArchive, Buffer.from([0]), { flag: 'a' })
    const corruptPrefix = join(temp, 'corrupt-prefix')
    result = await runInstaller([
      versionFlag, options.version, archiveFlag, corruptArchive, checksumFlag, '0'.repeat(64),
      prefixFlag, corruptPrefix, noPathFlag,
    ])
    assertFailure(result, 'tampered archive', 'checksum mismatch')
    if (existsSync(corruptPrefix)) throw new Error('Checksum failure created the installation prefix')

    const wrongVersionPrefix = join(temp, 'wrong-version-prefix')
    result = await runInstaller([
      versionFlag, '9.9.9', archiveFlag, archive, prefixFlag, wrongVersionPrefix, noPathFlag,
    ])
    assertFailure(result, 'archive/version mismatch', 'expected')
    if (existsSync(wrongVersionPrefix)) throw new Error('Version-mismatch failure created the installation prefix')

    const installPrefix = join(temp, 'install prefix with spaces')
    const home = join(temp, 'home')
    mkdirSync(home, { recursive: true })
    const desktopDir = join(home, 'Desktop')
    mkdirSync(desktopDir, { recursive: true })
    const installArgs = [versionFlag, options.version, archiveFlag, archive, prefixFlag, installPrefix]
    let userPathBefore
    if (platform === 'win') {
      installArgs.push(noPathFlag)
      userPathBefore = (await invoke('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"])).stdout.trim()
    }
    // The CI workflow exports DSH_VERSION at job level; scrub DSH_* so the installers
    // under test actually exercise version inference and release resolution.
    const scrubbed = { ...process.env }
    for (const key of Object.keys(scrubbed)) {
      if (key.startsWith('DSH_')) delete scrubbed[key]
    }
    const env = { ...scrubbed, HOME: home, DSH_HOME: join(home, '.dsh'), DSH_DESKTOP_DIR: desktopDir }
    result = await runInstaller(installArgs, env)
    assertSuccess(result, 'valid local archive installation')

    const shim = platform === 'win'
      ? join(installPrefix, 'bin', 'dsh.cmd')
      : join(installPrefix, 'bin', 'dsh')
    result = await invoke(shim, ['--version'], { env })
    assertSuccess(result, 'installed shim execution')
    if (result.output.trim() !== options.version) throw new Error(`Installed shim returned ${result.output.trim()}`)
    if (platform === 'linux') {
      const profile = readFileSync(join(home, '.profile'), 'utf8')
      if (!profile.includes("# dsh-cli-standalone user PATH") || !profile.includes("/bin'")) {
        throw new Error(`Linux PATH block was not written correctly:\n${profile}`)
      }
      console.log('PASS: Linux PATH profile update')
    } else {
      const userPathAfter = (await invoke('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"])).stdout.trim()
      if (userPathAfter !== userPathBefore) throw new Error('-NoModifyPath changed the Windows user PATH')
      console.log('PASS: Windows -NoModifyPath left user PATH unchanged')

      const shShim = join(installPrefix, 'bin', 'dsh')
      const shShimContent = readFileSync(shShim, 'utf8')
      if (shShimContent.includes('\r')) throw new Error('Git Bash shim must use LF line endings')
      if (!shShimContent.includes('dsh.cmd')) throw new Error('Git Bash shim does not forward to dsh.cmd')
      console.log('PASS: Git Bash shim installed next to dsh.cmd (LF endings)')
      const bash = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      ].find((candidate) => existsSync(candidate))
      if (bash) {
        const binPosix = dirname(shShim).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (match, drive) => `/${drive.toLowerCase()}`)
        result = await invoke(bash, ['-c', `PATH="${binPosix}:$PATH" dsh --version`], { env })
        assertSuccess(result, 'Git Bash shim execution')
        if (result.output.trim() !== options.version) throw new Error(`Git Bash shim returned ${result.output.trim()}`)
      } else {
        console.log('SKIP: Git Bash not found; shim execution not exercised')
      }

      const shortcut = join(desktopDir, 'dsh.lnk')
      if (!existsSync(shortcut)) throw new Error('Desktop shortcut was not created')
      const shortcutQuery = (await invoke('powershell.exe', ['-NoProfile', '-Command', `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${shortcut}'); "$($s.TargetPath)|$($s.Arguments)"`])).stdout.trim()
      const [shortcutTarget, shortcutArgs] = shortcutQuery.split('|')
      const actualShortcutTarget = realpathSync.native(shortcutTarget).toLowerCase()
      const expectedShortcutTarget = realpathSync.native(shim).toLowerCase()
      if (actualShortcutTarget !== expectedShortcutTarget) throw new Error(`Desktop shortcut targets ${shortcutTarget}; expected ${shim}`)
      if (shortcutArgs !== 'web') throw new Error(`Desktop shortcut arguments are ${shortcutArgs}; expected "web"`)
      console.log('PASS: Desktop shortcut targets the launcher with the web argument')
    }

    result = await runInstaller(installArgs, env)
    assertFailure(result, 'duplicate version installation', 'already installed')
    result = await invoke(shim, ['--version'], { env })
    assertSuccess(result, 'previous launcher and version directory survive duplicate rejection')
    if (result.output.trim() !== options.version) throw new Error('Previous launcher changed after duplicate rejection')

    result = await runInstaller([
      versionFlag, options.version, archiveFlag, corruptArchive, checksumFlag, '0'.repeat(64),
      prefixFlag, installPrefix, noPathFlag,
    ], env)
    assertFailure(result, 'tampered reinstall', 'checksum mismatch')
    result = await invoke(shim, ['--version'], { env })
    assertSuccess(result, 'previous launcher survives a failed reinstall')
    if (result.output.trim() !== options.version) throw new Error('Previous launcher changed after failed reinstall')

    if (platform === 'win') {
      const inferredPrefix = join(temp, 'inferred-version-prefix')
      copyFileSync(`${archive}.sha256`, `${isolatedArchive}.sha256`)
      result = await runInstaller([archiveFlag, isolatedArchive, prefixFlag, inferredPrefix, noPathFlag], env)
      assertSuccess(result, 'archive-name version inference installation')
      if (!result.output.toLowerCase().includes('resolved dsh version')) {
        throw new Error(`Version inference was not reported\n${result.output}`)
      }
      const inferredShim = join(inferredPrefix, 'bin', 'dsh.cmd')
      result = await invoke(inferredShim, ['--version'], { env })
      assertSuccess(result, 'inferred-version shim execution')
      if (result.output.trim() !== options.version) throw new Error(`Inferred-version shim returned ${result.output.trim()}`)

      const renamedArchive = join(temp, 'package.zip')
      copyFileSync(archive, renamedArchive)
      const renamedPrefix = join(temp, 'renamed-prefix')
      result = await runInstaller([archiveFlag, renamedArchive, prefixFlag, renamedPrefix, noPathFlag], env)
      assertFailure(result, 'archive name without version information', 'version')
      if (existsSync(renamedPrefix)) throw new Error('Unnamed-archive failure created the installation prefix')

      const foreignArchive = join(temp, `dsh-v${options.version}-linux-x64.tar.gz`)
      copyFileSync(archive, foreignArchive)
      const foreignPrefix = join(temp, 'foreign-prefix')
      result = await runInstaller([archiveFlag, foreignArchive, prefixFlag, foreignPrefix, noPathFlag], env)
      assertFailure(result, 'foreign-platform archive', 'win-x64')
      if (existsSync(foreignPrefix)) throw new Error('Foreign-platform failure created the installation prefix')

      const noShortcutDesktop = join(temp, 'no-shortcut-desktop')
      mkdirSync(noShortcutDesktop, { recursive: true })
      const noShortcutPrefix = join(temp, 'no-shortcut-prefix')
      result = await runInstaller([
        versionFlag, options.version, archiveFlag, archive, prefixFlag, noShortcutPrefix,
        noPathFlag, '-NoDesktopShortcut',
      ], { ...env, DSH_DESKTOP_DIR: noShortcutDesktop })
      assertSuccess(result, 'installation with -NoDesktopShortcut')
      if (existsSync(join(noShortcutDesktop, 'dsh.lnk'))) throw new Error('-NoDesktopShortcut still created a shortcut')
      if (!existsSync(join(noShortcutPrefix, 'bin', 'dsh'))) throw new Error('-NoDesktopShortcut removed the Git Bash shim')
      console.log('PASS: -NoDesktopShortcut creates no shortcut but keeps the Git Bash shim')

      await exerciseResolution('-ReleasesJsonUrl', '-GitHubProxy', env)
    } else {
      const inferredPrefix = join(temp, 'inferred-version-prefix')
      copyFileSync(`${archive}.sha256`, `${isolatedArchive}.sha256`)
      result = await runInstaller([archiveFlag, isolatedArchive, prefixFlag, inferredPrefix, noPathFlag], env)
      assertSuccess(result, 'archive-name version inference installation')
      if (!result.output.toLowerCase().includes('resolved dsh version')) {
        throw new Error(`Version inference was not reported\n${result.output}`)
      }
      const inferredShim = join(inferredPrefix, 'bin', 'dsh')
      result = await invoke(inferredShim, ['--version'], { env })
      assertSuccess(result, 'inferred-version shim execution')
      if (result.output.trim() !== options.version) throw new Error(`Inferred-version shim returned ${result.output.trim()}`)

      const renamedArchive = join(temp, 'package.tar.gz')
      copyFileSync(archive, renamedArchive)
      const renamedPrefix = join(temp, 'renamed-prefix')
      result = await runInstaller([archiveFlag, renamedArchive, prefixFlag, renamedPrefix, noPathFlag], env)
      assertFailure(result, 'archive name without version information', 'version')
      if (existsSync(renamedPrefix)) throw new Error('Unnamed-archive failure created the installation prefix')

      const foreignArchive = join(temp, `dsh-v${options.version}-win-x64.zip`)
      copyFileSync(archive, foreignArchive)
      const foreignPrefix = join(temp, 'foreign-prefix')
      result = await runInstaller([archiveFlag, foreignArchive, prefixFlag, foreignPrefix, noPathFlag], env)
      assertFailure(result, 'foreign-platform archive', 'linux-x64')
      if (existsSync(foreignPrefix)) throw new Error('Foreign-platform failure created the installation prefix')

      await exerciseResolution('--releases-json-url', '--github-proxy', env)
    }

    console.log('INSTALLER_REGRESSION_PASS')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
