#!/usr/bin/env node
/**
 * 生成 CNB 镜像仓库主页用的 README.md。
 *
 * CNB 仓库主页固定渲染「默认分支根目录的 README.md」，没有「指定其它 md 文件」的开关，
 * 所以这里把 doc/INSTALL-CNB.md（CNB 安装与同步手册）渲染成 CNB 仓库的 README.md，
 * 让主页直接展示面向 CNB 的手册；GitHub 源仓库的 README.md 保持不变。
 *
 * 用法:
 *   node scripts/render-cnb-readme.mjs --doc doc/INSTALL-CNB.md --out README.md
 *   node scripts/render-cnb-readme.mjs --out README.md --no-banner
 */

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return fallback;
  return v;
}
const has = (name) => process.argv.includes(`--${name}`);

const CNB_REPO = process.env.CNB_REPO || 'aixx.work/dsh-cli-standalone';
const CNB_DOMAIN = process.env.CNB_DOMAIN || 'cnb.cool';
const docPath = path.resolve(arg('doc', 'doc/INSTALL-CNB.md'));
const outPath = path.resolve(arg('out', 'README.md'));
const banner = !has('no-banner');

const doc = fs.readFileSync(docPath, 'utf8').trimEnd();

// 去掉手册里的一级标题，避免和主页标题重复
const body = doc.replace(/^#\s+.*\n/, '');

const header = banner
  ? `<!-- 本文件由 scripts/render-cnb-readme.mjs 基于 ${path.basename(docPath)} 自动生成，请勿直接编辑 -->

> **这是 CNB 镜像仓库**（源：<https://github.com/RainEchoA/dsh-cli-standalone>）。
> 主页内容即《dsh-cli-standalone · CNB 使用与安装手册》，仅面向 CNB 用户；
> 项目本身的构建与验证口径请看源仓库的 README。

[![CNB 定时同步](https://cnb.cool/${CNB_REPO}/-/badge/git/latest/ci/status/crontab)](https://cnb.cool/${CNB_REPO}/-/build/logs)
[![流水线配置](https://cnb.cool/${CNB_REPO}/-/badge/git/latest/ci/pipeline-as-code)](https://cnb.cool/${CNB_REPO}/-/blob/main/.cnb.yml)
[![Latest Release](https://cnb.cool/${CNB_REPO}/-/badge/release)](https://cnb.cool/${CNB_REPO}/-/badge/release.link)
[![Star](https://cnb.cool/${CNB_REPO}/-/badge/star)](https://cnb.cool/${CNB_REPO})
[![Fork](https://cnb.cool/${CNB_REPO}/-/badge/fork)](https://cnb.cool/${CNB_REPO})

---

`
  : '';

fs.writeFileSync(outPath, `${header}${body}\n`, 'utf8');
console.log(`[render-cnb-readme] 已生成 ${outPath}（来源 ${docPath}）`);
