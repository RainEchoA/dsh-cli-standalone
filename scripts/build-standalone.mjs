#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function usage() {
  return `Usage:
  node scripts/build-standalone.mjs --version <dsh-version> [options]

Options:
  --node-version <version>   Bundled Node.js version (default: 24.22.2)
  --platform <linux|win>     Target platform (default: current platform)
  --arch <x64>               Target architecture (default: x64)
  --package-spec <spec>      npm package spec (default: @deepseek-ai/dsh@<version>)
  --output-dir <path>        Artifact directory (default: dist)
  --keep-temp                Keep the temporary staging directory

The target platform must equal the build host platform. Native dependencies are
collected by npm on that host; this command does not cross-package Windows files.
`
}

function parseArgs(argv) {
  const options = {
    nodeVersion: '24.22.2',
    platform: process.platform === 'win32' ? 'win' : process.platform,
    arch: process.arch,
    outputDir: 'dist',
    keepTemp: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true
      continue
    }
    const names = {
      '--version': 'version',
      '--node-version': 'nodeVersion',
      '--platform': 'platform',
      '--arch': 'arch',
      '--package-spec': 'packageSpec',
      '--output-dir': 'outputDir',
    }
    const key = names[arg]
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${arg}\n\n${usage()}`)
    options[key] = argv[++index]
  }
  if (!options.version) throw new Error(`--version is required\n\n${usage()}`)
  options.packageSpec ??= `@deepseek-ai/dsh@${options.version}`
  return options
}

function assertSupported(options) {
  const hostPlatform = process.platform === 'win32' ? 'win' : process.platform
  if (!['linux', 'win'].includes(options.platform)) throw new Error(`Unsupported target platform: ${options.platform}`)
  if (options.platform !== hostPlatform) {
    throw new Error(`Refusing to cross-package ${options.platform} on ${hostPlatform}; native files must be collected on the target OS`)
  }
  if (options.arch !== 'x64' || process.arch !== 'x64') throw new Error('Only x64 on an x64 build host is supported')
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(options.version)) throw new Error(`Unsafe dsh version: ${options.version}`)
  if (!/^\d+\.\d+\.\d+$/.test(options.nodeVersion)) throw new Error(`Invalid Node.js version: ${options.nodeVersion}`)
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) {
    throw new Error(`Build host needs Node.js >= 24.9.0; current process uses ${process.version}`)
  }
}

function run(command, args, options = {}) {
  console.log(`+ ${command} ${args.join(' ')}`)
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) options = { ...options, shell: true }
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw new Error(`Failed to execute ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`)
}

function capture(command, args, options = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) options = { ...options, shell: true }
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw new Error(`Failed to execute ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result.stdout.trim()
}

function download(url, destination) {
  console.log(`Downloading ${url}`)
  run('curl', [
    '--fail', '--location', '--silent', '--show-error',
    '--retry', '3', '--retry-delay', '2', '--retry-connrefused',
    '--connect-timeout', '20', '--max-time', '600',
    '--output', destination, url,
  ])
  if (!existsSync(destination) || statSync(destination).size === 0) throw new Error(`Downloaded file is empty: ${url}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function expectedChecksum(contents, filename) {
  const matches = contents.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
    return match && match[2] === filename ? [match[1]] : []
  })
  if (matches.length !== 1) throw new Error(`Expected exactly one official checksum for ${filename}; found ${matches.length}`)
  return matches[0]
}

function nativeFiles(appDir, packageName) {
  const packageDir = join(appDir, 'node_modules', ...packageName.split('/'))
  if (!existsSync(packageDir)) throw new Error(`Required native dependency is missing: ${packageName}`)
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.node')) found.push(path)
    }
  }
  walk(packageDir)
  if (found.length === 0) throw new Error(`${packageName} contains no .node binary; install scripts or prebuilt binary collection did not complete`)
  return found.map((path) => path.slice(appDir.length + 1))
}

function writeLaunchers(bundleDir, platform) {
  const binDir = join(bundleDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const entry = 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'
  if (platform === 'linux') {
    const launcher = join(binDir, 'dsh')
    writeFileSync(launcher, `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/runtime/node" "$ROOT/${entry}" "$@"\n`)
    chmodSync(launcher, 0o755)
  } else {
    writeFileSync(join(binDir, 'dsh.cmd'), `@echo off\r\nsetlocal\r\nset "ROOT=%~dp0.."\r\n"%ROOT%\\runtime\\node.exe" "%ROOT%\\${entry.replaceAll('/', '\\')}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
  }
}

function copyNodeRuntime(extractDir, distributionName, bundleDir, platform) {
  const sourceRoot = join(extractDir, distributionName)
  if (!existsSync(sourceRoot)) throw new Error(`Node.js archive did not contain expected root ${distributionName}`)
  const runtimeDir = join(bundleDir, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const executable = platform === 'linux' ? 'node' : 'node.exe'
  copyFileSync(join(sourceRoot, platform === 'linux' ? 'bin' : '', executable), join(runtimeDir, executable))
  if (platform === 'linux') chmodSync(join(runtimeDir, executable), 0o755)
  const license = join(sourceRoot, 'LICENSE')
  if (!existsSync(license)) throw new Error('Node.js LICENSE was not found in the official archive')
  copyFileSync(license, join(runtimeDir, 'LICENSE'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  assertSupported(options)
  const outputDir = resolve(options.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const temp = join(tmpdir(), `dsh-standalone-${process.pid}-${Date.now()}`)
  const work = join(temp, 'work')
  const bundleParent = join(temp, 'bundle')
  const rootName = `dsh-v${options.version}-${options.platform}-${options.arch}`
  const bundleDir = join(bundleParent, rootName)
  mkdirSync(work, { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  console.log(`Staging directory: ${temp}`)

  try {
    const distributionName = `node-v${options.nodeVersion}-${options.platform === 'linux' ? 'linux-x64' : 'win-x64'}`
    const archiveName = `${distributionName}.${options.platform === 'linux' ? 'tar.xz' : 'zip'}`
    const baseUrl = `https://nodejs.org/dist/v${options.nodeVersion}`
    const runtimeArchive = join(work, archiveName)
    download(`${baseUrl}/${archiveName}`, runtimeArchive)
    const sumsPath = join(work, 'SHASUMS256.txt')
    download(`${baseUrl}/SHASUMS256.txt`, sumsPath)
    const expected = expectedChecksum(readFileSync(sumsPath, 'utf8'), archiveName)
    const actual = await sha256(runtimeArchive)
    if (actual !== expected) throw new Error(`Node.js checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`)
    console.log(`Verified Node.js SHA-256: ${actual}`)

    const extractDir = join(work, 'node-runtime')
    mkdirSync(extractDir)
    run('tar', ['-xf', runtimeArchive, '-C', extractDir])
    copyNodeRuntime(extractDir, distributionName, bundleDir, options.platform)

    const appDir = join(bundleDir, 'app')
    mkdirSync(appDir)
    writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-standalone-runtime',
      private: true,
      allowScripts: {
        '@deepseek-ai/dsh-subprocess-local': true,
        koffi: true,
        'node-pty': true,
        '@google/genai': true,
        protobufjs: true,
      },
    }, null, 2)}\n`)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    run(npm, [
      'install', '--omit=dev', '--include=optional', '--no-audit', '--no-fund',
      '--save-exact', '--package-lock=true', '--loglevel=warn', '--strict-allow-scripts',
      options.packageSpec,
    ], { cwd: appDir })

    const installedPackageJson = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(installedPackageJson)) throw new Error('npm installation did not produce @deepseek-ai/dsh/package.json')
    const installedPackage = JSON.parse(readFileSync(installedPackageJson, 'utf8'))
    if (installedPackage.version !== options.version) {
      throw new Error(`Installed dsh version ${installedPackage.version} does not match requested ${options.version}`)
    }

    const koffiPlatformPackage = options.platform === 'linux' ? '@koromix/koffi-linux-x64' : '@koromix/koffi-win32-x64'
    const nativeBinaries = {
      koffi: nativeFiles(appDir, koffiPlatformPackage),
      nodePty: nativeFiles(appDir, 'node-pty'),
      nodeAddonSystem: options.platform === 'linux'
        ? nativeFiles(appDir, '@deepseek-ai/node-addon-system-linux-x64')
        : 'not applicable: upstream publishes this addon family only for POSIX platforms',
    }
    if (options.platform === 'linux') {
      const landlock = join(appDir, 'node_modules', '@deepseek-ai', 'node-addon-system-linux-x64', 'bin', 'landlock-run')
      if (!existsSync(landlock)) throw new Error('Linux node-addon-system package does not contain bin/landlock-run')
      nativeBinaries.landlockLauncher = landlock.slice(appDir.length + 1)
    }
    if (options.platform === 'win' && !nativeBinaries.nodePty.some((path) => basename(path) === 'conpty.node')) {
      throw new Error('Windows node-pty package does not contain conpty.node')
    }
    console.log(`Verified native binaries: ${JSON.stringify(nativeBinaries)}`)
    const runtimeNode = join(bundleDir, 'runtime', options.platform === 'linux' ? 'node' : 'node.exe')
    const probeScript = fileURLToPath(new URL('./native-probe.mjs', import.meta.url))
    run(runtimeNode, [probeScript, appDir], { cwd: appDir })

    writeLaunchers(bundleDir, options.platform)
    const manifest = {
      schemaVersion: 1,
      dshVersion: installedPackage.version,
      nodeVersion: options.nodeVersion,
      nodeArchiveSha256: actual,
      platform: options.platform,
      arch: options.arch,
      upstreamPackage: options.packageSpec,
      nativeBinaries,
      builtAt: new Date().toISOString(),
    }
    writeFileSync(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(bundleDir, 'DISTRIBUTION.txt'), [
      'DeepSeek Harness standalone CLI runtime',
      `Upstream package: ${options.packageSpec}`,
      'Upstream license: MIT (https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)',
      'Node.js license: runtime/LICENSE',
      'Dependency package metadata and license files are retained under app/node_modules where published.',
      '',
    ].join('\n'))

    const launcher = join(bundleDir, 'bin', options.platform === 'linux' ? 'dsh' : 'dsh.cmd')
    const reportedVersion = capture(launcher, ['--version'])
    if (reportedVersion !== options.version) throw new Error(`Staged dsh --version returned ${JSON.stringify(reportedVersion)}`)
    capture(launcher, ['web', '--help'])

    const archive = join(outputDir, `${rootName}.${options.platform === 'linux' ? 'tar.gz' : 'zip'}`)
    if (existsSync(archive)) rmSync(archive)
    if (options.platform === 'linux') {
      run('tar', ['-czf', archive, '-C', bundleParent, rootName])
    } else {
      run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        'Compress-Archive -LiteralPath $env:DSH_PACK_ROOT -DestinationPath $env:DSH_PACK_OUT -CompressionLevel Optimal',
      ], { env: { ...process.env, DSH_PACK_ROOT: bundleDir, DSH_PACK_OUT: archive } })
    }
    const archiveHash = await sha256(archive)
    const checksumFile = `${archive}.sha256`
    writeFileSync(checksumFile, `${archiveHash}  ${basename(archive)}\n`)
    console.log(JSON.stringify({ archive, checksumFile, sha256: archiveHash, bytes: statSync(archive).size }, null, 2))
  } finally {
    if (options.keepTemp) console.log(`Keeping staging directory: ${temp}`)
    else rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`build-standalone: ${error.stack ?? error.message}`)
  process.exit(1)
})
