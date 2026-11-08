#!/usr/bin/env node
/**
 * 同步 GitHub Release（说明 + 附件）到 CNB Release。
 *
 * - 幂等：已存在且大小一致的附件会跳过，不重复下载 / 上传。
 * - 只搬运产物：不在 CNB 上执行任何构建。
 * - 纯 HTTP 实现（GitHub REST API + CNB OPENAPI），不依赖 cnb-rs / gh / git。
 *
 * 环境变量：
 *   GITHUB_REPO   源仓库，形如 owner/name（默认 RainEchoA/dsh-cli-standalone）
 *   GITHUB_TOKEN  可选，公开仓库可留空；设置后走认证，API 限额更高
 *   GITHUB_API    默认 https://api.github.com
 *   CNB_REPO      目标 CNB 仓库，形如 group/repo（默认 aixx.work/dsh-cli-standalone）
 *   CNB_TOKEN     必填，需要 repo-release:rw 权限
 *   CNB_API       默认 https://api.cnb.cool
 *   DRY_RUN       设为 1 时只打印计划，不做任何写操作
 */

const GITHUB_REPO = process.env.GITHUB_SOURCE_REPO || process.env.GITHUB_REPO || 'RainEchoA/dsh-cli-standalone';
const GITHUB_API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const CNB_REPO = process.env.CNB_REPO || process.env.CNB_REPO_SLUG || 'aixx.work/dsh-cli-standalone';
const CNB_API = (process.env.CNB_API || process.env.CNB_API_ENDPOINT || 'https://api.cnb.cool').replace(/\/$/, '');
const CNB_TOKEN = process.env.CNB_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!CNB_TOKEN) {
  console.error('[sync] 缺少 CNB_TOKEN 环境变量');
  process.exit(1);
}

const log = (...a) => console.log('[sync]', ...a);

function ghHeaders(extra = {}, { anonymous = false } = {}) {
  const h = {
    accept: 'application/vnd.github+json',
    'user-agent': 'cnb-release-sync',
    'x-github-api-version': '2022-11-28',
    ...extra,
  };
  if (GITHUB_TOKEN && !anonymous) h.authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

function cnbHeaders(extra = {}) {
  return {
    accept: 'application/vnd.cnb.api+json',
    'user-agent': 'cnb-release-sync',
    authorization: `Bearer ${CNB_TOKEN}`,
    ...extra,
  };
}

async function ghJson(path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders() });
  if (res.status === 401 && GITHUB_TOKEN) {
    // token 无效时退回匿名访问（公开仓库仍可读）
    const retry = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders({}, { anonymous: true }) });
    if (retry.ok) return retry.json();
  }
  if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function cnbJson(path, init = {}) {
  const res = await fetch(`${CNB_API}${path}`, {
    ...init,
    headers: cnbHeaders(init.headers || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(`CNB ${path} -> ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 列出 GitHub 上所有已发布的 release（跳过草稿） */
async function listGithubReleases() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ghJson(`/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}`);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter((r) => !r.draft);
}

/** 取 tag 指向的 commit sha */
async function githubTagCommit(tag) {
  try {
    const c = await ghJson(`/repos/${GITHUB_REPO}/commits/${encodeURIComponent(tag)}`);
    return c.sha;
  } catch {
    return null;
  }
}

/** 取 CNB 上的 release，不存在返回 null */
async function getCnbRelease(tag) {
  try {
    return await cnbJson(`/${CNB_REPO}/-/releases/tags/${encodeURIComponent(tag)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** commit 是否已存在于 CNB 仓库 */
async function cnbHasCommit(sha) {
  if (!sha) return false;
  try {
    await cnbJson(`/${CNB_REPO}/-/git/commits/${sha}`);
    return true;
  } catch {
    return false;
  }
}

async function ensureCnbRelease(rel, sha) {
  let release = await getCnbRelease(rel.tag_name);
  const patch = {
    name: rel.name || rel.tag_name,
    body: rel.body || '',
    draft: false,
    prerelease: !!rel.prerelease,
  };
  // 仅在确定“最新版本”时设置 latest，避免误改
  if (rel.__latest) patch.make_latest = 'true';

  if (!release) {
    if (DRY_RUN) {
      log(`[dry-run] 创建 CNB release ${rel.tag_name}`);
      return { id: 'dry-run', ...patch, assets: [] };
    }
    const created = await cnbJson(`/${CNB_REPO}/-/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: rel.tag_name,
        name: patch.name,
        body: patch.body,
        draft: false,
        prerelease: patch.prerelease,
        ...(patch.make_latest ? { make_latest: patch.make_latest } : {}),
        // tag 不存在时，CNB 会基于该 commitish 自动打 tag
        target_commitish: (await cnbHasCommit(sha)) ? sha : 'main',
      }),
    });
    log(`  创建 CNB release ${rel.tag_name} (id=${created.id})`);
    return created;
  }

  const needUpdate =
    release.name !== patch.name ||
    (release.body || '') !== patch.body ||
    !!release.prerelease !== patch.prerelease;
  if (needUpdate && !DRY_RUN) {
    await cnbJson(`/${CNB_REPO}/-/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    log(`  更新 CNB release ${rel.tag_name} 说明/标记`);
  }
  return release;
}

/** 下载 GitHub 附件到内存（Buffer） */
async function downloadAsset(asset) {
  // 优先走 API 附件地址（可被代理/网络策略放行），失败再回退到浏览器下载地址
  const attempts = [
    { url: asset.url, headers: ghHeaders({ accept: 'application/octet-stream' }) },
    { url: asset.browser_download_url, headers: ghHeaders() },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { headers: a.headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`下载 ${asset.name} 失败: ${lastErr && lastErr.message}`);
}

/** 上传附件到 CNB release：预签名 URL -> PUT -> 确认 */
async function uploadAsset(releaseId, asset, buffer) {
  const { upload_url, verify_url } = await cnbJson(
    `/${CNB_REPO}/-/releases/${releaseId}/asset-upload-url`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        asset_name: asset.name,
        size: buffer.length,
        overwrite: true,
        ttl: 0,
      }),
    }
  );

  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer,
  });
  if (!put.ok) throw new Error(`上传 ${asset.name} -> ${put.status} ${await put.text()}`);

  const verify = await fetch(verify_url, { method: 'POST', headers: cnbHeaders() });
  if (!verify.ok) throw new Error(`确认 ${asset.name} -> ${verify.status} ${await verify.text()}`);
}

async function main() {
  log(`源仓库: ${GITHUB_REPO}  ->  目标 CNB 仓库: ${CNB_REPO}`);
  if (DRY_RUN) log('DRY_RUN 模式：不做任何写操作');

  const releases = await listGithubReleases();
  log(`GitHub 上发现 ${releases.length} 个 release`);

  // 标记 GitHub 上最新的正式版
  const latest = releases.find((r) => !r.prerelease && !r.draft);
  if (latest) latest.__latest = true;

  let uploaded = 0;
  let skipped = 0;

  for (const rel of releases) {
    const tag = rel.tag_name;
    const assets = rel.assets || [];
    log(`检查 release ${tag}（附件 ${assets.length} 个）`);

    const sha = await githubTagCommit(tag);
    const release = await ensureCnbRelease(rel, sha);
    const existing = new Map((release.assets || []).map((a) => [a.name, a]));

    for (const asset of assets) {
      const cur = existing.get(asset.name);
      if (cur && Number(cur.size) === Number(asset.size)) {
        log(`  跳过 ${asset.name}（已存在且大小一致）`);
        skipped++;
        continue;
      }
      if (DRY_RUN) {
        log(`  [dry-run] 下载并上传 ${asset.name}（${asset.size} 字节）`);
        continue;
      }
      log(`  下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MiB）`);
      const buf = await downloadAsset(asset);
      await uploadAsset(release.id, asset, buf);
      log(`  已上传 ${asset.name}`);
      uploaded++;
    }
  }

  log(`完成：上传 ${uploaded} 个，跳过 ${skipped} 个`);
}

main().catch((err) => {
  console.error('[sync] 失败:', err.message);
  process.exit(1);
});
