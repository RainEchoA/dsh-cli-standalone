#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function main() {
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
  try {
    const isolated = join(temp, 'isolated')
    const isolatedArchive = join(isolated, basename(archive))
    mkdirSync(isolated, { recursive: true })
    copyFileSync(archive, isolatedArchive)
    const missingChecksumPrefix = join(temp, 'missing-checksum-prefix')
    let result = runInstaller([versionFlag, options.version, archiveFlag, isolatedArchive, prefixFlag, missingChecksumPrefix, noPathFlag])
    assertFailure(result, 'local archive without a checksum', 'checksum')
    if (existsSync(missingChecksumPrefix)) throw new Error('Missing-checksum failure created the installation prefix')

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
    const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }
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

    console.log('INSTALLER_REGRESSION_PASS')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

main()
