#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options })
  return {
    ...result,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function assertSuccess(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label} failed (${result.status}): ${result.error?.message ?? ''}\n${result.output}`)
  console.log(`PASS: ${label}`)
}

function assertFailure(result, label, expectedText) {
  if (result.error || result.status === 0) throw new Error(`${label} unexpectedly succeeded\n${result.output}`)
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
  const runInstaller = (installerArgs, env = process.env) => {
    const [command, commandArgs] = installerInvocation(root, platform, installerArgs)
    return invoke(command, commandArgs, { env })
  }
  // Version resolution must skip dev/alpha prereleases and pick the semver maximum on any
  // platform. The proxy flag under test points at this stub server, so the version API
  // and download requests must arrive rewritten as "<proxy>/https://api.github.com/..."
  // and "<proxy>/https://github.com/..."; the download then 404s on purpose, so the run
  // must fail while still having logged which version it resolved.
  const exerciseResolution = async (proxyFlag, env) => {
    const releaseTags = ['v2.0.0-alpha.1', 'v2.0.0-dev.3', 'v1.0.1-rc.1', 'v1.0.0', 'v0.3.0-beta.1', 'v0.2.9', 'not-a-semver']
    const requestedPaths = []
    const apiServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      requestedPaths.push(url.pathname)
      if (url.pathname.endsWith('/releases')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(releaseTags.map((tag) => ({ tag_name: tag }))))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    await new Promise((listen) => apiServer.listen(0, '127.0.0.1', listen))
    try {
      const apiPort = apiServer.address().port
      const resolvedPrefix = join(temp, `resolved-prefix-${platform}`)
      const resolutionResult = runInstaller([
        proxyFlag, `http://127.0.0.1:${apiPort}`,
        prefixFlag, resolvedPrefix, noPathFlag,
      ], env)
      assertFailure(resolutionResult, 'latest-release resolution excludes dev/alpha', 'resolved dsh version: 1.0.1-rc.1')
      if (existsSync(resolvedPrefix)) throw new Error('Resolution failure created the installation prefix')
      if (!requestedPaths.some((p) => p.startsWith('/https://api.github.com/'))) {
        throw new Error(`version API was not rewritten through the proxy: ${JSON.stringify(requestedPaths)}`)
      }
      if (!requestedPaths.some((p) => p.startsWith('/https://github.com/'))) {
        throw new Error(`release download was not rewritten through the proxy: ${JSON.stringify(requestedPaths)}`)
      }
      console.log('PASS: GitHub proxy rewriting applied to version API and downloads')
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
    let result = runInstaller([versionFlag, options.version, archiveFlag, isolatedArchive, prefixFlag, noChecksumPrefix, noPathFlag])
    assertSuccess(result, 'local archive without a checksum installs with verification skipped')
    if (!result.output.toLowerCase().includes('skipping')) {
      throw new Error(`Checksum skip was not reported\n${result.output}`)
    }
    if (!existsSync(join(noChecksumPrefix, 'bin'))) throw new Error('Checksum-less install did not create the installation prefix')

    const corruptArchive = join(temp, basename(archive))
    copyFileSync(archive, corruptArchive)
    writeFileSync(corruptArchive, Buffer.from([0]), { flag: 'a' })
    const corruptPrefix = join(temp, 'corrupt-prefix')
    result = runInstaller([
      versionFlag, options.version, archiveFlag, corruptArchive, checksumFlag, '0'.repeat(64),
      prefixFlag, corruptPrefix, noPathFlag,
    ])
    assertFailure(result, 'tampered archive', 'checksum mismatch')
    if (existsSync(corruptPrefix)) throw new Error('Checksum failure created the installation prefix')

    const wrongVersionPrefix = join(temp, 'wrong-version-prefix')
    result = runInstaller([
      versionFlag, '9.9.9', archiveFlag, archive, prefixFlag, wrongVersionPrefix, noPathFlag,
    ])
    assertFailure(result, 'archive/version mismatch', 'expected')
    if (existsSync(wrongVersionPrefix)) throw new Error('Version-mismatch failure created the installation prefix')

    const installPrefix = join(temp, 'install prefix with spaces')
    const home = join(temp, 'home')
    mkdirSync(home, { recursive: true })
    const installArgs = [versionFlag, options.version, archiveFlag, archive, prefixFlag, installPrefix]
    let userPathBefore
    if (platform === 'win') {
      installArgs.push(noPathFlag)
      userPathBefore = invoke('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"]).stdout?.trim()
    }
    // The CI workflow exports DSH_VERSION at job level; scrub DSH_* so the installers
    // under test actually exercise version inference and release resolution.
    const scrubbed = { ...process.env }
    for (const key of Object.keys(scrubbed)) {
      if (key.startsWith('DSH_')) delete scrubbed[key]
    }
    const env = { ...scrubbed, HOME: home, DSH_HOME: join(home, '.dsh') }
    result = runInstaller(installArgs, env)
    assertSuccess(result, 'valid local archive installation')

    const shim = platform === 'win'
      ? join(installPrefix, 'bin', 'dsh.cmd')
      : join(installPrefix, 'bin', 'dsh')
    result = invoke(shim, ['--version'], { env })
    assertSuccess(result, 'installed shim execution')
    if (result.output.trim() !== options.version) throw new Error(`Installed shim returned ${result.output.trim()}`)
    if (platform === 'linux') {
      const profile = readFileSync(join(home, '.profile'), 'utf8')
      if (!profile.includes("# dsh-cli-standalone user PATH") || !profile.includes("/bin'")) {
        throw new Error(`Linux PATH block was not written correctly:\n${profile}`)
      }
      console.log('PASS: Linux PATH profile update')
    } else {
      const userPathAfter = invoke('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"]).stdout?.trim()
      if (userPathAfter !== userPathBefore) throw new Error('-NoModifyPath changed the Windows user PATH')
      console.log('PASS: Windows -NoModifyPath left user PATH unchanged')
    }

    result = runInstaller(installArgs, env)
    assertFailure(result, 'duplicate version installation', 'already installed')
    result = invoke(shim, ['--version'], { env })
    assertSuccess(result, 'previous launcher and version directory survive duplicate rejection')
    if (result.output.trim() !== options.version) throw new Error('Previous launcher changed after duplicate rejection')

    result = runInstaller([
      versionFlag, options.version, archiveFlag, corruptArchive, checksumFlag, '0'.repeat(64),
      prefixFlag, installPrefix, noPathFlag,
    ], env)
    assertFailure(result, 'tampered reinstall', 'checksum mismatch')
    result = invoke(shim, ['--version'], { env })
    assertSuccess(result, 'previous launcher survives a failed reinstall')
    if (result.output.trim() !== options.version) throw new Error('Previous launcher changed after failed reinstall')

    if (platform === 'win') {
      const inferredPrefix = join(temp, 'inferred-version-prefix')
      copyFileSync(`${archive}.sha256`, `${isolatedArchive}.sha256`)
      result = runInstaller([archiveFlag, isolatedArchive, prefixFlag, inferredPrefix, noPathFlag], env)
      assertSuccess(result, 'archive-name version inference installation')
      if (!result.output.toLowerCase().includes('resolved dsh version')) {
        throw new Error(`Version inference was not reported\n${result.output}`)
      }
      const inferredShim = join(inferredPrefix, 'bin', 'dsh.cmd')
      result = invoke(inferredShim, ['--version'], { env })
      assertSuccess(result, 'inferred-version shim execution')
      if (result.output.trim() !== options.version) throw new Error(`Inferred-version shim returned ${result.output.trim()}`)

      const renamedArchive = join(temp, 'package.zip')
      copyFileSync(archive, renamedArchive)
      const renamedPrefix = join(temp, 'renamed-prefix')
      result = runInstaller([archiveFlag, renamedArchive, prefixFlag, renamedPrefix, noPathFlag], env)
      assertFailure(result, 'archive name without version information', 'version')
      if (existsSync(renamedPrefix)) throw new Error('Unnamed-archive failure created the installation prefix')

      const foreignArchive = join(temp, `dsh-v${options.version}-linux-x64.tar.gz`)
      copyFileSync(archive, foreignArchive)
      const foreignPrefix = join(temp, 'foreign-prefix')
      result = runInstaller([archiveFlag, foreignArchive, prefixFlag, foreignPrefix, noPathFlag], env)
      assertFailure(result, 'foreign-platform archive', 'win-x64')
      if (existsSync(foreignPrefix)) throw new Error('Foreign-platform failure created the installation prefix')

      await exerciseResolution('-GitHubProxy', env)
    } else {
      const inferredPrefix = join(temp, 'inferred-version-prefix')
      copyFileSync(`${archive}.sha256`, `${isolatedArchive}.sha256`)
      result = runInstaller([archiveFlag, isolatedArchive, prefixFlag, inferredPrefix, noPathFlag], env)
      assertSuccess(result, 'archive-name version inference installation')
      if (!result.output.toLowerCase().includes('resolved dsh version')) {
        throw new Error(`Version inference was not reported\n${result.output}`)
      }
      const inferredShim = join(inferredPrefix, 'bin', 'dsh')
      result = invoke(inferredShim, ['--version'], { env })
      assertSuccess(result, 'inferred-version shim execution')
      if (result.output.trim() !== options.version) throw new Error(`Inferred-version shim returned ${result.output.trim()}`)

      const renamedArchive = join(temp, 'package.tar.gz')
      copyFileSync(archive, renamedArchive)
      const renamedPrefix = join(temp, 'renamed-prefix')
      result = runInstaller([archiveFlag, renamedArchive, prefixFlag, renamedPrefix, noPathFlag], env)
      assertFailure(result, 'archive name without version information', 'version')
      if (existsSync(renamedPrefix)) throw new Error('Unnamed-archive failure created the installation prefix')

      const foreignArchive = join(temp, `dsh-v${options.version}-win-x64.zip`)
      copyFileSync(archive, foreignArchive)
      const foreignPrefix = join(temp, 'foreign-prefix')
      result = runInstaller([archiveFlag, foreignArchive, prefixFlag, foreignPrefix, noPathFlag], env)
      assertFailure(result, 'foreign-platform archive', 'linux-x64')
      if (existsSync(foreignPrefix)) throw new Error('Foreign-platform failure created the installation prefix')

      await exerciseResolution('--github-proxy', env)
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
