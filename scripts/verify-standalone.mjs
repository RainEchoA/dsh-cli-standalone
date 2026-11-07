#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = { '--archive': 'archive', '--version': 'version', '--platform': 'platform', '--skip-web': 'skipWeb' }[argv[index]]
    if (argv[index] === '--skip-web') {
      options.skipWeb = true
      continue
    }
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    options[key] = argv[++index]
  }
  if (!options.archive || !options.version) throw new Error('Usage: node scripts/verify-standalone.mjs --archive <file> --version <version> [--platform <linux|win>] [--skip-web]')
  options.platform ??= process.platform === 'win32' ? 'win' : process.platform
  return options
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${output}`)
  return output.trim()
}

function makeFakeNode(temp, platform, env) {
  const fakeBin = join(temp, 'fake-system-node')
  mkdirSync(fakeBin)
  if (platform === 'linux') {
    for (const name of ['node', 'npm', 'pnpm']) {
      const path = join(fakeBin, name)
      writeFileSync(path, '#!/bin/sh\necho "ERROR: standalone launcher accidentally used system $0" >&2\nexit 97\n')
      run('chmod', ['+x', path])
    }
  } else {
    for (const name of ['node.cmd', 'npm.cmd', 'pnpm.cmd']) {
      writeFileSync(join(fakeBin, name), '@echo off\r\necho ERROR: standalone launcher accidentally used a system tool 1>&2\r\nexit /b 97\r\n')
    }
  }
  return { ...env, PATH: `${fakeBin}${delimiter}${env.PATH ?? ''}` }
}

function walk(dir, suffix, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, suffix, found)
    else if (entry.name.endsWith(suffix)) found.push(path)
  }
  return found
}

function killProcessTree(child, platform) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

async function verifyWeb(launcher, env, temp, platform) {
  const home = join(temp, 'web-home')
  mkdirSync(home)
  const child = spawn(launcher, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...env, DSH_HOME: home, NO_COLOR: '1', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  const safeLogs = () => logs.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>')
  let url
  const consume = (chunk) => {
    const text = chunk.toString()
    logs += text
    if (logs.length > 1_000_000) logs = logs.slice(-500_000)
    const clean = logs.replace(/\x1b\[[0-9;]*m/g, '')
    url ??= clean.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]*/)?.[0]
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + 120_000
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error(`dsh web exited before serving a page\n${safeLogs()}`)
      if (url) {
        try {
          const first = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
          let response = first
          if ([301, 302, 303, 307, 308].includes(first.status)) {
            const location = first.headers.get('location')
            if (!location) throw new Error(`HTTP ${first.status} without Location`)
            const setCookie = first.headers.get('set-cookie')
            const cookie = setCookie?.split(';')[0]
            response = await fetch(new URL(location, url), {
              redirect: 'follow',
              headers: cookie ? { cookie } : {},
              signal: AbortSignal.timeout(10_000),
            })
          }
          const body = await response.text()
          const contentType = response.headers.get('content-type') ?? ''
          if (response.status !== 200 || !contentType.includes('text/html') || !/<html[\s>]/i.test(body)) {
            throw new Error(`Unexpected Web GUI response: status=${response.status}, content-type=${contentType}, bytes=${body.length}`)
          }
          const parsed = new URL(url)
          return { origin: parsed.origin, status: response.status, htmlBytes: body.length }
        } catch (error) {
          if (Date.now() + 1000 >= deadline) throw error
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    }
    throw new Error(`Timed out waiting for a valid Web GUI page\n${safeLogs()}`)
  } finally {
    killProcessTree(child, platform)
    await new Promise((resolveExit) => {
      if (exited) resolveExit()
      else {
        const timer = setTimeout(resolveExit, 5000)
        child.once('exit', () => { clearTimeout(timer); resolveExit() })
      }
    })
    console.log('--- dsh web output (last 12000 characters) ---')
    console.log(safeLogs().slice(-12_000))
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const hostPlatform = process.platform === 'win32' ? 'win' : process.platform
  if (options.platform !== hostPlatform) throw new Error(`Cannot execute a ${options.platform} archive on ${hostPlatform}`)
  const archive = resolve(options.archive)
  if (!existsSync(archive)) throw new Error(`Archive not found: ${archive}`)
  const temp = mkdtempSync(join(tmpdir(), 'dsh-standalone-verify-'))
  try {
    run('tar', ['-xf', archive, '-C', temp])
    const rootName = `dsh-v${options.version}-${options.platform}-x64`
    const root = join(temp, rootName)
    const launcher = join(root, 'bin', options.platform === 'linux' ? 'dsh' : 'dsh.cmd')
    if (!existsSync(launcher)) throw new Error(`Launcher missing after archive extraction: ${launcher}`)
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    if (manifest.dshVersion !== options.version) throw new Error(`Manifest version mismatch: ${manifest.dshVersion}`)
    const env = makeFakeNode(temp, options.platform, process.env)
    const versionOutput = capture(launcher, ['--version'], { env })
    if (versionOutput !== options.version) throw new Error(`Expected dsh --version ${options.version}, got ${JSON.stringify(versionOutput)}`)
    const help = capture(launcher, ['--help'], { env })
    if (!help.includes('web')) throw new Error('dsh --help did not list the web profile')
    const webHelp = capture(launcher, ['web', '--help'], { env })
    if (!webHelp.includes('--no-open')) throw new Error('dsh web --help did not contain --no-open')
    const nativeFiles = walk(join(root, 'app'), '.node').map((path) => relative(root, path))
    const runtimeNode = join(root, 'runtime', options.platform === 'linux' ? 'node' : 'node.exe')
    const probeScript = fileURLToPath(new URL('./native-probe.mjs', import.meta.url))
    const nativeProbe = capture(runtimeNode, [probeScript, join(root, 'app')], { env })
    console.log(nativeProbe)
    const evidence = { version: versionOutput, fakeSystemNodeGuard: 'passed', nativeNodeModules: nativeFiles, nativeProbe: 'passed' }
    if (!options.skipWeb) evidence.web = await verifyWeb(launcher, env, temp, options.platform)
    else evidence.web = 'not tested (--skip-web)'
    console.log(`STANDALONE_VERIFICATION ${JSON.stringify(evidence, null, 2)}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`verify-standalone: ${error.stack ?? error.message}`)
  process.exit(1)
})
