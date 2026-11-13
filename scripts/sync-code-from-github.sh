#!/bin/sh
# 把 GitHub 源仓库镜像到 CNB：全部分支 + tag + 完整提交历史，并在 main 之上追加一次
# 「CNB 主页 README」生成提交。
#
# 为什么不用 tencentcom/git-sync 的 pull 模式：
#   pull 模式内部执行 `git pull --rebase`，会把 CNB 侧那条自动生成的
#   「docs: 更新 CNB 主页 README」提交重放到 GitHub 的历史之上。而 README.md 在两边
#   本就是有意不同的（GitHub 放项目说明，CNB 放 doc/INSTALL-CNB.md 生成的手册），
#   所以只要 GitHub 侧动过 README，rebase 必定 CONFLICT，后续 stage 全部 skipped。
#
# 这里改成「以 GitHub 为准重建 main」的线性流程：
#   CNB main = GitHub main + 1 个重新生成的 README 提交（force 推送，无分叉、无冲突）。
#   内容没变时直接跳过推送，保持幂等。
#
# 环境变量：
#   GITHUB_SOURCE_REPO  owner/name（GITHUB_SOURCE_URL 未给时用它拼地址）
#   GITHUB_SOURCE_URL   GitHub 仓库地址
#   CNB_REPO            目标仓库 slug，如 aixx.work/dsh-cli-standalone
#   CNB_TOKEN           流水线内置令牌（写本仓库）
#   CNB_DOMAIN          CNB 域名，默认 cnb.cool
#   SYNC_MODE           full（默认：分支 + tag + README）| readme（只重建 README）
#   README_DOC          生成源文件，默认 doc/INSTALL-CNB.md
set -eu

cd "${CNB_BUILD_WORKSPACE:-/workspace}"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "[sync-code] 当前目录不是 Git 仓库: $PWD" >&2; exit 1; }

CNB_DOMAIN="${CNB_DOMAIN:-cnb.cool}"
CNB_REPO="${CNB_REPO:?请设置 CNB_REPO}"
CNB_TOKEN="${CNB_TOKEN:?缺少 CNB_TOKEN}"
SYNC_MODE="${SYNC_MODE:-full}"
README_DOC="${README_DOC:-doc/INSTALL-CNB.md}"
GITHUB_SOURCE_URL="${GITHUB_SOURCE_URL:-https://github.com/${GITHUB_SOURCE_REPO:?请设置 GITHUB_SOURCE_REPO}.git}"

log() { printf '[sync-code] %s\n' "$*"; }
GIT="git -c core.hooksPath=/dev/null"

# 提交不签名、不依赖宿主 git 配置
git config commit.gpgsign false
git config user.name "cnb-ci"
git config user.email "cnb-ci@aixx.me"
git config --global --add safe.directory "$PWD" 2>/dev/null || true

# 凭据只在内存里，不落盘（先清掉宿主机可能预置的 store helper）
git config --unset-all credential.helper >/dev/null 2>&1 || true
git config credential.helper '!f() { echo username=oauth2; echo password="${CNB_TOKEN}"; }; f'
PUSH_URL="$(git remote get-url origin 2>/dev/null || echo "https://${CNB_DOMAIN}/${CNB_REPO}.git")"

log "源仓库: $GITHUB_SOURCE_URL"
log "目标仓库: $PUSH_URL  模式: $SYNC_MODE"

git remote remove github >/dev/null 2>&1 || true
git remote add github "$GITHUB_SOURCE_URL"

if [ "$SYNC_MODE" = "full" ]; then
  log "拉取 GitHub 全部提交历史与 tag"
  git fetch --force --prune --tags github
else
  log "只拉取 GitHub main"
  git fetch --force github main
fi

git rev-parse --verify -q github/main >/dev/null || { echo "[sync-code] 错误：GitHub 上没有 main 分支" >&2; exit 1; }

# ---- 以 GitHub main 为基线重建本地分支，并重新生成 CNB 主页 README
log "重建本地 main <= github/main"
git checkout -q -f -B cnb-mirror-main github/main
cp README.md /tmp/readme.github 2>/dev/null || true

if [ -f "$README_DOC" ]; then
  node scripts/render-cnb-readme.mjs --doc "$README_DOC" --out README.md
  git add README.md
  if cmp -s README.md /tmp/readme.github; then
    log "生成结果与 GitHub README 相同，不追加提交"
  else
    $GIT commit -q -m "docs: 更新 CNB 主页 README（由 ${README_DOC} 生成）"
    log "已生成主页 README 提交"
  fi
else
  log "警告：缺少 $README_DOC，跳过主页 README 生成"
fi

# ---- 幂等判断：CNB 远端 main 除 README 外与 GitHub main 一致、README 内容也一致就跳过
SKIP_MAIN=0
if git fetch -q --force origin "refs/heads/main:refs/remotes/origin/main" 2>/dev/null; then
  if git diff --quiet origin/main github/main -- . ':(exclude)README.md' 2>/dev/null \
     && git show origin/main:README.md 2>/dev/null | cmp -s - README.md; then
    SKIP_MAIN=1
    log "CNB main 已是最新，跳过 main 推送"
  fi
fi

if [ "$SKIP_MAIN" -eq 0 ]; then
  log "推送 main -> CNB（force）"
  $GIT push -q --force "$PUSH_URL" cnb-mirror-main:refs/heads/main
fi

if [ "$SYNC_MODE" = "full" ]; then
  # ---- 其余分支：对齐 GitHub 上存在的分支；CNB 侧多出来的不删（避免误删人工分支）
  # 注意：%(refname:short) 会把 github/HEAD 符号引用显示成 "github"，这里用完整 refname 判断
  for refname in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
    branch="${refname#refs/remotes/github/}"
    case "$branch" in "$refname"|main|HEAD) continue ;; esac
    log "推送分支 $branch"
    $GIT push -q --force "$PUSH_URL" "${refname}:refs/heads/${branch}" \
      || log "警告：分支 $branch 推送失败"
  done

  log "推送 tag（force，与 GitHub 对齐）"
  $GIT push -q --force "$PUSH_URL" --tags || log "警告：tag 推送失败"
fi

log "完成"
