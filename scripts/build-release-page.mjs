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
  const latest = data.releases[0]
  const repositoryUrl = `https://github.com/${data.repository}`
  const releaseItems = data.releases.map((release, index) => `        <li>
          <a class="release-card" href="${escapeHtml(release.url)}" aria-label="查看 ${escapeHtml(release.version)} Release">
            <span class="release-number">${String(index + 1).padStart(2, '0')}</span>
            <span class="release-main">
              <span class="release-title">
                <strong>${escapeHtml(release.version)}</strong>
                <span class="badge ${release.prerelease ? 'badge-pre' : 'badge-stable'}">${release.prerelease ? '预发布' : '正式版'}</span>
              </span>
              <span class="release-meta"><code>${escapeHtml(release.tag)}</code><span aria-hidden="true">·</span>${release.publishedAt ? `<time datetime="${escapeHtml(release.publishedAt)}">${escapeHtml(release.publishedAt.slice(0, 10))}</time>` : '未记录发布时间'}</span>
            </span>
            <span class="release-action">查看 Release <span aria-hidden="true">↗</span></span>
          </a>
        </li>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="dsh-cli-standalone 已发布版本与静态 JSON 索引">
  <title>${escapeHtml(data.repository)} · Releases</title>
  <style>
    :root { color-scheme: dark; --bg: #080b14; --panel: #111725; --line: #263047; --text: #f2f5ff; --muted: #929db5; --cyan: #63e6d4; --violet: #a78bfa; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; color: var(--text); background: radial-gradient(circle at 12% 0%, #173c4b80, transparent 32rem), radial-gradient(circle at 88% 12%, #34265c70, transparent 34rem), var(--bg); }
    a { color: inherit; text-decoration: none; }
    a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 5px; }
    code, .brand-mark, .eyebrow, .release-number, .count { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    .shell { width: min(1080px, calc(100% - 48px)); margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 30px 0; border-bottom: 1px solid #ffffff0c; }
    .brand { display: flex; gap: 12px; align-items: center; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
    .brand-mark { display: grid; width: 38px; height: 38px; place-items: center; color: #071410; background: linear-gradient(135deg, var(--cyan), #a7f3d0); border-radius: 11px; font-size: 13px; font-weight: 900; box-shadow: 0 0 28px #63e6d426; }
    .github-link { display: flex; gap: 8px; align-items: center; padding: 8px 14px; color: #d4dbec; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; transition: border-color .2s, background .2s; }
    .github-link:hover { background: #ffffff08; border-color: #52617e; }
    .hero { padding: 82px 0 64px; }
    .eyebrow { display: flex; gap: 10px; align-items: center; margin: 0 0 20px; color: var(--cyan); font-size: 11px; font-weight: 700; letter-spacing: .16em; }
    .eyebrow::before { width: 22px; height: 1px; content: ""; background: var(--cyan); }
    h1 { max-width: 760px; margin: 0; font-size: clamp(42px, 7vw, 76px); line-height: 1.04; letter-spacing: -.055em; }
    h1 span { color: transparent; background: linear-gradient(100deg, var(--cyan), #a7f3d0 42%, var(--violet)); background-clip: text; -webkit-background-clip: text; }
    .intro { max-width: 610px; margin: 25px 0 0; color: var(--muted); font-size: 16px; line-height: 1.8; }
    .hero-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; margin-top: 42px; }
    .feature-card { position: relative; display: flex; min-height: 174px; flex-direction: column; justify-content: space-between; overflow: hidden; padding: 25px 27px; background: linear-gradient(135deg, #162231e8, #101624e8); border: 1px solid var(--line); border-radius: 20px; transition: transform .2s, border-color .2s; }
    .feature-card:hover { transform: translateY(-3px); border-color: #52617e; }
    .feature-card.latest::after { position: absolute; right: -60px; bottom: -100px; width: 240px; height: 240px; content: ""; background: #63e6d412; border-radius: 50%; filter: blur(5px); }
    .card-label { position: relative; z-index: 1; color: var(--muted); font-size: 12px; }
    .latest-version { position: relative; z-index: 1; margin: 12px 0; overflow-wrap: anywhere; font-size: clamp(25px, 4vw, 36px); font-weight: 720; letter-spacing: -.04em; }
    .card-link { position: relative; z-index: 1; color: var(--cyan); font-size: 13px; }
    .api-card { background: linear-gradient(135deg, #19172de8, #111522e8); }
    .api-card code { display: inline-block; margin: 18px 0; color: #ddd6fe; font-size: 18px; overflow-wrap: anywhere; }
    .api-card .card-link { color: #c4b5fd; }
    .releases { padding: 8px 0 72px; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 22px; }
    .section-kicker { margin: 0 0 5px; color: var(--muted); font-size: 10px; letter-spacing: .18em; }
    h2 { margin: 0; font-size: 25px; letter-spacing: -.025em; }
    .count { padding: 6px 10px; color: var(--muted); background: #ffffff05; border: 1px solid var(--line); border-radius: 8px; font-size: 10px; letter-spacing: .08em; }
    .release-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .release-card { display: grid; grid-template-columns: 42px 1fr auto; gap: 18px; align-items: center; padding: 22px 24px; background: #101522b8; border: 1px solid #232c40; border-radius: 15px; transition: background .2s, border-color .2s, transform .2s; }
    .release-card:hover { background: #151c2c; border-color: #40506c; transform: translateX(3px); }
    .release-number { color: #5e6b84; font-size: 12px; }
    .release-main { min-width: 0; }
    .release-title { display: flex; flex-wrap: wrap; gap: 11px; align-items: center; }
    .release-title strong { overflow-wrap: anywhere; font-size: 18px; letter-spacing: -.02em; }
    .badge { padding: 3px 8px; border: 1px solid; border-radius: 999px; font-size: 10px; font-weight: 600; }
    .badge-stable { color: var(--cyan); background: #63e6d40c; border-color: #63e6d42e; }
    .badge-pre { color: #c4b5fd; background: #a78bfa0c; border-color: #a78bfa30; }
    .release-meta { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 7px; color: var(--muted); font-size: 12px; }
    .release-meta code { color: #aeb9cd; }
    .release-action { color: #aab5ca; font-size: 12px; white-space: nowrap; }
    .release-action span { display: inline-block; margin-left: 5px; color: var(--cyan); transition: transform .2s; }
    .release-card:hover .release-action span { transform: translate(2px, -2px); }
    .empty { padding: 48px; color: var(--muted); text-align: center; background: var(--panel); border: 1px dashed var(--line); border-radius: 16px; }
    .footer { display: flex; justify-content: space-between; gap: 20px; padding: 23px 0 32px; color: #657189; border-top: 1px solid #ffffff0c; font-size: 11px; }
    @media (max-width: 700px) {
      .shell { width: min(100% - 30px, 1080px); }
      .topbar { padding: 20px 0; }
      .brand { font-size: 12px; }
      .github-link { padding: 7px 10px; }
      .hero { padding: 55px 0 44px; }
      .hero-grid { grid-template-columns: 1fr; margin-top: 32px; }
      .feature-card { min-height: 155px; }
      .release-card { grid-template-columns: 1fr auto; gap: 12px; padding: 19px; }
      .release-number { display: none; }
      .release-action { font-size: 0; }
      .release-action span { font-size: 18px; }
      .footer { flex-direction: column; gap: 5px; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="${escapeHtml(repositoryUrl)}"><span class="brand-mark">DS</span><span>dsh-cli-standalone</span></a>
      <a class="github-link" href="${escapeHtml(repositoryUrl)}" aria-label="在 GitHub 查看仓库">GitHub <span aria-hidden="true">↗</span></a>
    </header>
    <main>
      <section class="hero">
        <p class="eyebrow">DEEPSEEK HARNESS · STANDALONE</p>
        <h1>Release <span>版本索引</span></h1>
        <p class="intro">集中查看独立运行时的所有已发布版本，共 ${data.releases.length} 个版本。包含正式版与预发布版本，同时提供无需 GitHub API 的静态 JSON 接口。</p>
        <div class="hero-grid">
          ${latest ? `<a class="feature-card latest" href="${escapeHtml(latest.url)}">
            <span class="card-label">最新发布 · ${latest.prerelease ? '预发布' : '正式版'}</span>
            <strong class="latest-version">${escapeHtml(latest.version)}</strong>
            <span class="card-link">查看此版本 <span aria-hidden="true">↗</span></span>
          </a>` : `<div class="feature-card latest"><span class="card-label">最新发布</span><strong class="latest-version">暂无版本</strong></div>`}
          <a class="feature-card api-card" href="releases.json">
            <span class="card-label">面向程序与镜像仓库</span>
            <code>releases.json</code>
            <span class="card-link">读取静态 JSON <span aria-hidden="true">↗</span></span>
          </a>
        </div>
      </section>
      <section class="releases" aria-labelledby="releases-title">
        <div class="section-heading">
          <div><p class="section-kicker">RELEASE ARCHIVE</p><h2 id="releases-title">全部版本</h2></div>
          <span class="count">${data.releases.length} RELEASES</span>
        </div>
        ${data.releases.length ? `<ol class="release-list">\n${releaseItems}\n        </ol>` : '<p class="empty">尚未发布 Release。</p>'}
      </section>
    </main>
    <footer class="footer">
      <span>dsh-cli-standalone · Static release index</span>
      <span>更新于 <time datetime="${escapeHtml(data.generatedAt)}">${escapeHtml(data.generatedAt)}</time></span>
    </footer>
  </div>
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
