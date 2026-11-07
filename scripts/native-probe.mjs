#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync, constants, accessSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const appDir = resolve(process.argv[2] ?? (() => { throw new Error('Usage: node scripts/native-probe.mjs <archive/app-directory>') })())
const require = createRequire(join(appDir, 'package.json'))
const evidence = {}

require('koffi')
evidence.koffi = 'loaded'

const pty = require('node-pty')
const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'] : ['-c', 'exit 0']
const terminal = pty.spawn(shell, shellArgs, { name: 'xterm', cwd: appDir, env: process.env })
const ptyExit = new Promise((resolveExit) => terminal.onExit(resolveExit))
const ptyTimeout = setTimeout(() => {
  terminal.kill()
  throw new Error('node-pty shell exit probe timed out')
}, 20_000)
const ptyResult = await ptyExit
clearTimeout(ptyTimeout)
assert.equal(ptyResult.exitCode, 0, `node-pty shell exited with ${ptyResult.exitCode}`)
evidence.nodePty = { shellExitCode: ptyResult.exitCode, shell }

if (process.platform === 'linux') {
  const flockPath = require.resolve('@deepseek-ai/node-addon-system/flock')
  const landlockPath = require.resolve('@deepseek-ai/node-addon-system/landlock-run')
  const { tryLockExclusive } = await import(pathToFileURL(flockPath).href)
  const { grantArgs, launcherPath, probe } = await import(pathToFileURL(landlockPath).href)

  const lockRoot = mkdtempSync(join(tmpdir(), 'dsh-native-flock-'))
  const handles = []
  try {
    const lock = join(lockRoot, 'lock')
    const first = openSync(lock, 'wx+', 0o600)
    handles.push(first)
    const second = openSync(lock, 'r+')
    handles.push(second)
    await tryLockExclusive(first)
    await assert.rejects(tryLockExclusive(second), { code: 'EAGAIN' })
    closeSync(first)
    handles.splice(handles.indexOf(first), 1)
    await tryLockExclusive(second)
    evidence.flock = 'exclusion and close release passed'
  } finally {
    for (const fd of handles) closeSync(fd)
    rmSync(lockRoot, { recursive: true, force: true })
  }

  const launcher = launcherPath()
  assert.ok(existsSync(launcher), `Landlock launcher missing: ${launcher}`)
  accessSync(launcher, constants.X_OK)
  const enforcement = probe(launcher)
  evidence.landlock = { launcher, probe: enforcement }
  if (enforcement !== 'unusable') {
    const work = mkdtempSync(join(tmpdir(), 'dsh-landlock-proof-'))
    try {
      const denied = join(work, 'denied.txt')
      const deniedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'] }), '--', '/bin/sh', '-c', `echo x > '${denied}'`], { encoding: 'utf8' })
      assert.notEqual(deniedRun.status, 0, 'Landlock denied write unexpectedly succeeded')
      assert.ok(!existsSync(denied), 'Landlock denied write reached disk')
      const granted = join(work, 'granted.txt')
      const grantedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'], readWrite: [work] }), '--', '/bin/sh', '-c', `echo ok > '${granted}'`], { encoding: 'utf8' })
      assert.equal(grantedRun.status, 0, `Landlock granted write failed: ${grantedRun.stderr}`)
      assert.equal(readFileSync(granted, 'utf8').trim(), 'ok')
      evidence.landlock.worldProof = 'denied write blocked; granted write succeeded'
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  } else {
    evidence.landlock.worldProof = 'not run: launcher reported unusable on this kernel'
  }
}

const loaded = process.report.getReport().sharedObjects.map((path) => path.replaceAll('\\', '/'))
const koffiLoaded = loaded.filter((path) => path.includes('koffi.node'))
assert.ok(koffiLoaded.length > 0, 'Koffi native binary absent from process shared-object report')
if (process.platform === 'linux') {
  assert.ok(koffiLoaded.some((path) => path.includes('linux_x64/koffi.node')), `Koffi glibc binary not selected: ${koffiLoaded}`)
  assert.ok(!koffiLoaded.some((path) => path.includes('musl_')), `Koffi musl fallback was selected: ${koffiLoaded}`)
  assert.ok(loaded.some((path) => path.includes('bin/glibc/system.node')), 'node-addon-system glibc flock binary was not loaded')
  assert.ok(!loaded.some((path) => path.includes('bin/musl/system.node')), 'node-addon-system musl flock binary was selected on glibc')
} else if (process.platform === 'win32') {
  assert.ok(loaded.some((path) => path.toLowerCase().endsWith('conpty.node')), `ConPTY addon not loaded: ${loaded.filter((path) => path.endsWith('.node'))}`)
}
evidence.loadedNativeLibraries = loaded.filter((path) => path.endsWith('.node'))
console.log(`NATIVE_PROBE ${JSON.stringify(evidence, null, 2)}`)
// node-pty's ConPTY handle keeps the libuv loop referenced on Windows after the
// shell exits, so this probe would never exit on its own; tear it down and leave.
try { terminal.kill() } catch { /* already dead */ }
setTimeout(() => process.exit(0), 500)
