#!/usr/bin/env bash
# 本地一键同步：把本仓库（GitHub）镜像到 CNB，并同步 GitHub Release 产物。
#
# 依赖: git、node（>=18）、gh（可选，仅用于校验）
# 认证: export CNB_TOKEN=... 或 cnb-rs auth login
#
# 用法:
#   scripts/sync-cnb.sh [--repo aixx.work/dsh-cli-standalone] [--dry-run]
#
# 行为:
#   1. 关闭仓库的「推送自动触发构建」，只保留「定时任务自动触发」，
#      保证同步过程不会产生任何构建。
#   2. 把本地分支与 tag 镜像到 CNB 仓库。
#   3. 调用 scripts/sync-release.mjs 同步 GitHub Release 的说明与附件（幂等）。

set -euo pipefail

CNB_REPO="${CNB_REPO:-aixx.work/dsh-cli-standalone}"
CNB_DOMAIN="${CNB_DOMAIN:-cnb.cool}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) CNB_REPO="$2"; shift 2 ;;
    --domain) CNB_DOMAIN="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[36m[cnb-sync]\033[0m %s\n' "$*"; }

command -v git >/dev/null || { echo "missing dependency: git" >&2; exit 1; }
command -v node >/dev/null || { echo "missing dependency: node" >&2; exit 1; }

# ------------------------------------------------ 1. 只保留定时任务触发
if command -v cnb-rs >/dev/null 2>&1; then
  log "设置流水线触发策略：推送不触发构建 / 定时任务可触发"
  [[ $DRY_RUN -eq 1 ]] || cnb-rs repo settings pipeline set \
    --domain "$CNB_DOMAIN" --repo "$CNB_REPO" \
    --auto-trigger false \
    --auto-trigger-by-npc false \
    --cron-auto-trigger true \
    --fork-auto-trigger false >/dev/null
  [[ $DRY_RUN -eq 1 ]] || cnb-rs repo settings pipeline get "$CNB_REPO" --domain "$CNB_DOMAIN" --json
else
  log "未安装 cnb-rs，跳过流水线触发设置（npm i -g @cnb-rs/cli）"
fi

# ------------------------------------------------ 2. 镜像代码
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git remote get-url cnb >/dev/null 2>&1; then
    git remote set-url cnb "https://cnb.cool/${CNB_REPO}.git"
  else
    git remote add cnb "https://cnb.cool/${CNB_REPO}.git"
  fi
  log "镜像分支与 tag 到 ${CNB_REPO}"
  if [[ $DRY_RUN -eq 0 ]]; then
    git push --quiet cnb 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
  fi
else
  log "当前目录不是 Git 仓库，跳过代码镜像"
fi

# ------------------------------------------------ 3. 同步 Release 产物
log "同步 GitHub Release 产物"
if [[ $DRY_RUN -eq 1 ]]; then
  DRY_RUN=1 CNB_REPO="$CNB_REPO" node scripts/sync-release.mjs
else
  CNB_REPO="$CNB_REPO" node scripts/sync-release.mjs
fi

log "完成"
