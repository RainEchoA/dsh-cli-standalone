#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const options = {
    repo: process.env.GITHUB_REPOSITORY || 'RainEchoA/dsh-cli-standalone',
    api: process.env.GITHUB_API_URL || process.env.GITHUB_API || 'https://api.github.com',
    outputDir: 'dist-pages',
  }
  const names = {
    '--repo': 'repo',
    '--api': 'api',
    '--output-dir': 'outputDir',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = names[argv[index]]
    if (!key || index + 1 >= argv.length) {
      throw new Error('Usage: node scripts/build-release-page.mjs [--repo owner/name] [--api url] [--output-dir path]')
    }
    options[key] = argv[++index]
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`Invalid GitHub repository: ${options.repo}`)
  options.api = options.api.replace(/\/$/, '')
  return options
}

async function fetchReleases(options) {
  const releases = []
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-release-page',
    'x-github-api-version': '2022-11-28',
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  for (let page = 1; ; page += 1) {
    const url = `${options.api}/repos/${options.repo}/releases?per_page=100&page=${page}`
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}: ${await response.text()}`)
    const batch = await response.json()
    if (!Array.isArray(batch)) throw new Error('GitHub releases API did not return an array')
    releases.push(...batch)
    if (batch.length < 100) return releases.filter((release) => !release.draft)
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function normalizeRelease(release, repo) {
  if (!release.tag_name) throw new Error('A published release is missing tag_name')
  return {
    version: release.tag_name.replace(/^v(?=\d)/, ''),
    tag: release.tag_name,
    prerelease: Boolean(release.prerelease),
    publishedAt: release.published_at,
    url: release.html_url || `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`,
  }
}

function renderHtml(data) {
  const rows = data.releases.map((release) => `          <tr>
            <td><strong>${escapeHtml(release.version)}</strong></td>
            <td><code>${escapeHtml(release.tag)}</code></td>
            <td>${release.prerelease ? '预发布' : '正式版'}</td>
            <td>${release.publishedAt ? `<time datetime="${escapeHtml(release.publishedAt)}">${escapeHtml(release.publishedAt)}</time>` : '—'}</td>
            <td><a href="${escapeHtml(release.url)}">查看 Release</a></td>
          </tr>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.repository)} · Releases</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .65rem; border-bottom: 1px solid #8885; text-align: left; }
    th { white-space: nowrap; }
    code { overflow-wrap: anywhere; }
    .meta { opacity: .75; }
    .empty { padding: 2rem 0; }
    @media (max-width: 700px) { body { padding: 1rem; } td:nth-child(4), th:nth-child(4) { display: none; } }
  </style>
</head>
<body>
  <main>
    <h1>dsh-cli-standalone Releases</h1>
    <p>本页列出仓库已发布的非草稿 Release，共 ${data.releases.length} 个版本，包含预发布版本。</p>
    <p>程序可直接读取 <a href="releases.json"><code>releases.json</code></a>，无需调用 GitHub API。</p>
    <p class="meta">生成时间：<time datetime="${escapeHtml(data.generatedAt)}">${escapeHtml(data.generatedAt)}</time></p>
    ${data.releases.length ? `<table>
      <thead><tr><th>版本</th><th>Tag</th><th>类型</th><th>发布时间</th><th>链接</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>` : '<p class="empty">尚未发布 Release。</p>'}
  </main>
</body>
</html>
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const releases = (await fetchReleases(options)).map((release) => normalizeRelease(release, options.repo))
  const data = {
    schemaVersion: 1,
    repository: options.repo,
    generatedAt: new Date().toISOString(),
    versions: releases.map((release) => release.version),
    releases,
  }
  const outputDir = resolve(options.outputDir)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'releases.json'), `${JSON.stringify(data, null, 2)}\n`)
  writeFileSync(join(outputDir, 'index.html'), renderHtml(data))
  writeFileSync(join(outputDir, '.nojekyll'), '')
  console.log(JSON.stringify({ outputDir, releases: releases.length, versions: data.versions }, null, 2))
}

main().catch((error) => {
  console.error(`build-release-page: ${error.stack ?? error.message}`)
  process.exit(1)
})
