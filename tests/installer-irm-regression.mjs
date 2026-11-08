#!/usr/bin/env node
// Offline regression for the irm|iex one-line entry of install.ps1 (the same file also
// supports -File invocation, which tests/installer-regression.mjs covers). A localhost
// server serves the real install.ps1 and the test builds a fake dsh archive locally, so
// no GitHub access is required, nothing real is installed, and the user PATH is never
// touched.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerSource = readFileSync(join(root, 'install.ps1'), 'utf8')
const version = '0.2.2-rc.1'

let failures = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL: ${label}${detail ? `\n${detail}` : ''}`)
}

// Async on purpose: while an installer child process runs, the in-process localhost
// server must keep answering requests; spawnSync would freeze the event loop and
// deadlock every case until its HTTP timeout.
function invoke(command, commandArgs, options = {}) {
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

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-irm-regression-'))

  // Build a fake dsh-v<version>-win-x64.zip plus its sibling .sha256, fully offline.
  const staging = join(temp, 'staging')
  const fakeRoot = join(staging, `dsh-v${version}-win-x64`)
  mkdirSync(join(fakeRoot, 'bin'), { recursive: true })
  mkdirSync(join(fakeRoot, 'runtime'), { recursive: true })
  writeFileSync(
    join(fakeRoot, 'bin', 'dsh.cmd'),
    '@echo off\r\nif /i "%~1"=="--version" (echo ' + version + '&exit /b 0)\r\nexit /b 0\r\n',
  )
  writeFileSync(join(fakeRoot, 'runtime', 'node.exe'), '')
  writeFileSync(join(fakeRoot, 'manifest.json'), '{}')
  const archive = join(temp, `dsh-v${version}-win-x64.zip`)
  const build = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `[IO.Compression.ZipFile]::CreateFromDirectory('${staging}', '${archive}')`,
  ])
  if (build.status !== 0 || !existsSync(archive)) throw new Error(`fake archive build failed\n${build.output}`)
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${hash}  dsh-v${version}-win-x64.zip\n`)

  const releaseTags = ['v2.0.0-alpha.1', 'v2.0.0-dev.3', 'v1.0.1-rc.1', 'v1.0.0', 'v0.3.0-beta.1', 'v0.2.9']
  const requestedPaths = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requestedPaths.push(url.pathname)
    const respond = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    if (url.pathname === '/install.ps1') return respond(200, installerSource)
    if (url.pathname.endsWith('/releases')) {
      return respond(200, JSON.stringify(releaseTags.map((tag) => ({ tag_name: tag }))), 'application/json')
    }
    return respond(404, 'not found')
  })
  await new Promise((listen) => server.listen(0, '127.0.0.1', listen))
  const port = server.address().port

  // The user-facing one-liner is `irm <url> | iex`. The outer fetch itself is not what is
  // being tested here, so fetch with -UseBasicParsing to stay safe on headless systems
  // where the legacy IE-based parsing path is unavailable; execution still goes through
  // iex, exactly like the documented command.
  const iexCommand = `iex (irm -UseBasicParsing http://127.0.0.1:${port}/install.ps1)`

  const runCase = async (name, caseEnv) => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('DSH_')) delete env[key]
    }
    Object.assign(env, caseEnv)
    return invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', iexCommand], { env })
  }

  const shimVersion = async (prefix) => {
    const shim = join(prefix, 'bin', 'dsh.cmd')
    if (!existsSync(shim)) return { ok: false, detail: `shim missing at ${shim}` }
    const run = await invoke(shim, ['--version'])
    return { ok: run.status === 0 && run.output.trim() === version, detail: run.output }
  }

  const userPath = async () =>
    (await invoke('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"])).stdout.trim()

  // 1. Full flow through iex: explicit DSH_VERSION + local archive + prefix with spaces.
  {
    const pathBefore = await userPath()
    const prefix = join(temp, 'prefix with spaces')
    const result = await runCase('mapping', {
      DSH_VERSION: version,
      DSH_ARCHIVE: archive,
      DSH_PREFIX: prefix,
      DSH_NO_MODIFY_PATH: '1',
    })
    assert(result.status === 0, 'irm|iex full install exits zero', result.output)
    assert(/installed dsh 0\.2\.2-rc\.1/i.test(result.output), 'install completion reported', result.output)
    const shim = await shimVersion(prefix)
    assert(shim.ok, 'installed shim reports the expected version', shim.detail)
    assert((await userPath()) === pathBefore, 'DSH_NO_MODIFY_PATH left the user PATH unchanged')
  }

  // 2. Without DSH_VERSION the archive file name provides the version.
  {
    const prefix = join(temp, 'inferred prefix')
    const result = await runCase('inference', {
      DSH_ARCHIVE: archive,
      DSH_PREFIX: prefix,
      DSH_NO_MODIFY_PATH: '1',
    })
    assert(result.status === 0, 'version inferred from archive name under iex', result.output)
    assert(/from archive name/i.test(result.output), 'inference was reported', result.output)
    const shim = await shimVersion(prefix)
    assert(shim.ok, 'inferred-version shim works', shim.detail)
  }

  // 3. Unsafe DSH_VERSION is rejected by the installer itself.
  {
    const result = await runCase('unsafe', {
      DSH_VERSION: '../evil',
      DSH_ARCHIVE: archive,
      DSH_PREFIX: join(temp, 'unsafe prefix'),
      DSH_NO_MODIFY_PATH: '1',
    })
    assert(result.status !== 0, 'unsafe DSH_VERSION fails non-zero', result.output)
    assert(/unsafe version/i.test(result.output), 'unsafe version message surfaced', result.output)
  }

  // 4. No version anywhere and a dead release API -> hard failure, not a silent guess.
  {
    const result = await runCase('noversion', {
      DSH_RELEASES_API_URL: `http://127.0.0.1:${port}/nope`,
      DSH_PREFIX: join(temp, 'noversion prefix'),
      DSH_NO_MODIFY_PATH: '1',
    })
    assert(result.status !== 0, 'unresolvable version fails non-zero', result.output)
    assert(/failed to list dsh releases/i.test(result.output), 'release API failure surfaced', result.output)
  }

  // 5. DSH_GH_PROXY rewrites the version API and download URLs; resolution still works.
  {
    requestedPaths.length = 0
    const prefix = join(temp, 'proxy prefix')
    const result = await runCase('proxy', {
      DSH_GH_PROXY: `http://127.0.0.1:${port}`,
      DSH_PREFIX: prefix,
      DSH_NO_MODIFY_PATH: '1',
    })
    assert(result.status !== 0 && /resolved dsh version: 1\.0\.1-rc\.1/i.test(result.output), 'latest resolution through proxy picks 1.0.1-rc.1', result.output)
    assert(requestedPaths.some((p) => p.startsWith('/https://api.github.com/')), 'version API request rewritten through proxy', JSON.stringify(requestedPaths))
    assert(requestedPaths.some((p) => p.startsWith('/https://github.com/')), 'download request rewritten through proxy', JSON.stringify(requestedPaths))
  }

  await new Promise((close) => server.close(close))
  rmSync(temp, { recursive: true, force: true })
  if (failures > 0) {
    console.error(`INSTALLER_IRM_REGRESSION_FAIL (${failures} failure(s))`)
    process.exit(1)
  }
  console.log('INSTALLER_IRM_REGRESSION_PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
