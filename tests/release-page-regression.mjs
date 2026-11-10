#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`Release page generator exited with ${status}:\n${output}`))
      else resolvePromise(output)
    })
  })
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'dsh-release-page-'))
const firstPage = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.0.${99 - index}`,
  draft: index === 99,
  prerelease: index === 0,
  published_at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  html_url: `https://github.com/example/project/releases/tag/v1.0.${99 - index}`,
}))
firstPage[0].tag_name = 'v1.0.0-rc.1"><script>alert(1)</script>'
firstPage[0].html_url = 'https://github.com/example/project/releases/tag/v1.0.0-rc.1'
const requestedPages = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname !== '/repos/example/project/releases') {
    response.writeHead(404).end()
    return
  }
  const page = Number(url.searchParams.get('page'))
  requestedPages.push(page)
  assert.equal(url.searchParams.get('per_page'), '100')
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(page === 1 ? firstPage : [{ tag_name: 'v0.1.0', draft: false, prerelease: false }]))
})

await new Promise((listen) => server.listen(0, '127.0.0.1', listen))
try {
  const port = server.address().port
  await run(process.execPath, [
    join(root, 'scripts/build-release-page.mjs'),
    '--repo', 'example/project',
    '--api', `http://127.0.0.1:${port}`,
    '--output-dir', temp,
  ])
  const data = JSON.parse(readFileSync(join(temp, 'releases.json'), 'utf8'))
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.repository, 'example/project')
  assert.equal(data.releases.length, 100)
  assert.equal(data.versions.length, 100)
  assert.equal(data.versions[0], '1.0.0-rc.1"><script>alert(1)</script>')
  assert.equal(data.versions.at(-1), '0.1.0')
  assert.ok(!data.versions.includes('1.0.0'))
  assert.equal(data.releases[0].prerelease, true)
  assert.equal(data.releases.at(-1).url, 'https://github.com/example/project/releases/tag/v0.1.0')
  assert.deepEqual(requestedPages, [1, 2])
  const html = readFileSync(join(temp, 'index.html'), 'utf8')
  assert.ok(html.includes('共 100 个版本'))
  assert.ok(html.includes('releases.json'))
  assert.ok(html.includes('irm https://raw.githubusercontent.com/example/project/main/install.ps1 | iex'))
  assert.ok(html.includes('curl -fsSL https://raw.githubusercontent.com/example/project/main/install.sh | sh'))
  assert.ok(html.includes("if (/windows/i.test(system)) selectPlatform('windows', true)"))
  assert.ok(html.includes('navigator.clipboard?.writeText'))
  assert.ok(html.includes('document.execCommand(\'copy\')'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(existsSync(join(temp, '.nojekyll')))
  console.log('RELEASE_PAGE_REGRESSION_PASS')
} finally {
  await new Promise((close) => server.close(close))
  rmSync(temp, { recursive: true, force: true })
}
