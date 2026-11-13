#!/usr/bin/env bash
# 本地一键同步：GitHub 源仓库 → CNB 镜像仓库（代码全量历史 + Release 产物 + 主页 README）。
#
# 依赖: git、node（>=18）、cnb-rs（npm i -g @cnb-rs/cli）
# 认证: export CNB_TOKEN=... 或 cnb-rs auth login
#
# 用法:
#   scripts/sync-cnb.sh [--repo aixx.work/dsh-cli-standalone] [--no-trigger] [--dry-run]
#
# 单写入者模型（避免互相覆盖）：
#   GitHub  = 代码唯一真源（含 .cnb.yml / 文档 / 脚本）
#   CNB     = 由仓库里的定时/手动流水线负责镜像：
#              1) scripts/sync-code-from-github.sh：全部分支 + tag + 完整提交历史，
#                 并在 main 之上生成主页 README（不用 git-sync pull 模式，原因见该脚本注释）
#              2) scripts/sync-release.mjs：Release 说明与附件（幂等）
#              3) scripts/render-cnb-readme.mjs：CNB 主页 README（由 doc/INSTALL-CNB.md 生成）
#   本脚本只负责：把本地提交推到 GitHub，然后触发 CNB 流水线。

set -euo pipefail

CNB_REPO="${CNB_REPO:-aixx.work/dsh-cli-standalone}"
CNB_DOMAIN="${CNB_DOMAIN:-cnb.cool}"
TRIGGER=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) CNB_REPO="$2"; shift 2 ;;
    --domain) CNB_DOMAIN="$2"; shift 2 ;;
    --no-trigger) TRIGGER=0; shift ;;
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
  if [[ $DRY_RUN -eq 0 ]]; then
    cnb-rs repo settings pipeline set \
      --domain "$CNB_DOMAIN" --repo "$CNB_REPO" \
      --auto-trigger false \
      --auto-trigger-by-npc false \
      --cron-auto-trigger true \
      --fork-auto-trigger false >/dev/null
    cnb-rs repo settings pipeline get "$CNB_REPO" --domain "$CNB_DOMAIN" --json
  fi
else
  log "未安装 cnb-rs，跳过流水线触发设置（npm i -g @cnb-rs/cli）"
fi

# ------------------------------------------------ 2. 推送到 GitHub 源仓库
if git rev-parse --git-dir >/dev/null 2>&1; then
  log "推送本地提交到 GitHub 源仓库（CNB 流水线以此为准做全量镜像）"
  if [[ $DRY_RUN -eq 0 ]]; then
    git push --quiet origin main
    git push --quiet --force --tags origin || true
  fi
else
  log "当前目录不是 Git 仓库，跳过代码推送"
fi

# ------------------------------------------------ 3. 触发 CNB 流水线
if [[ $TRIGGER -eq 1 ]]; then
  if command -v cnb-rs >/dev/null 2>&1; then
    log "触发 CNB 流水线（代码镜像 + 产物同步 + 主页 README）"
    if [[ $DRY_RUN -eq 0 ]]; then
      cnb-rs build start --domain "$CNB_DOMAIN" --repo "$CNB_REPO" \
        -b main -e api_trigger --sync --json || true
    fi
  else
    log "未安装 cnb-rs，跳过触发（可稍后手动运行：cnb-rs build start --repo ${CNB_REPO} -e api_trigger）"
  fi
fi

# ------------------------------------------------ 4. 本地立即同步产物（可选）
if [[ -f scripts/sync-release.mjs ]]; then
  log "本地同步 GitHub Release 产物到 CNB（幂等）"
  if [[ $DRY_RUN -eq 1 ]]; then
    DRY_RUN=1 CNB_REPO="$CNB_REPO" node scripts/sync-release.mjs
  else
    CNB_REPO="$CNB_REPO" node scripts/sync-release.mjs
  fi
fi

log "完成"
