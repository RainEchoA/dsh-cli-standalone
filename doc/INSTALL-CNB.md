# dsh-cli-standalone · CNB 使用与安装手册

> 本文件独立于 `README.md`，专门面向 **CNB（cnb.cool）** 镜像仓库的安装、下载与同步机制说明。
> `README.md` 描述的是项目本身的构建与验证口径，本手册只讲「从 CNB 拿产物、怎么装、怎么同步」。

## 1. CNB 镜像仓库信息

| 项目 | 值 |
| --- | --- |
| CNB 仓库 | <https://cnb.cool/aixx.work/dsh-cli-standalone> |
| GitHub 源仓库 | <https://github.com/RainEchoA/dsh-cli-standalone> |
| Release 列表 | <https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases> |
| 单个附件下载 | `https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download/<tag>/<文件名>` |
| 仓库原始文件（raw） | `https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/<路径>` |
| 同步策略 | 每天 01:00（Asia/Shanghai）定时任务自动同步 GitHub Release 产物 |

CNB 仓库是 GitHub 源仓库的**只读镜像 + 产物分发点**：代码与 tag 随源仓库同步，Release 附件由定时任务搬运，
**不在 CNB 上执行任何构建**（仓库流水线「推送自动触发」已关闭，仅保留「定时任务自动触发」）。

## 2. 安装（Linux / macOS）

安装脚本通过环境变量把下载源切到 CNB：

```sh
# 1) 指定版本（不带 v 前缀）；CNB 的版本列表接口需要登录，务必显式指定
export DSH_VERSION=0.2.2-rc.1

# 2) 把 Release 下载地址切到 CNB
export DSH_BASE_URL=https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download

# 3) 执行 CNB 上的安装脚本
curl -fsSL https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/install.sh | bash
```

等价的命令行参数形式：

```sh
curl -fsSL https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/install.sh | bash -s -- \
  --version 0.2.2-rc.1 \
  --base-url https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download
```

其它可用环境变量（含义与 GitHub 安装方式一致）：

- `DSH_ARCHIVE`：本地归档离线安装，如 `dsh-v0.2.2-rc.1-linux-x64.tar.gz`。
- `DSH_CHECKSUM`：显式指定 SHA-256（缺省时若归档旁有 `.sha256` 则自动校验）。
- `DSH_PREFIX`：安装前缀，默认 `$HOME/.local`（可执行文件落在 `$HOME/.local/bin/dsh`，版本目录在 `$HOME/.local/share/dsh/versions/<版本>`）。
- `DSH_RELEASES_API_URL`：版本列表 API；**CNB 的该接口需要登录令牌**，未显式指定 `DSH_VERSION` 时请不要指向 CNB。
- `DSH_GH_PROXY`：GitHub 加速代理（仅在仍走 GitHub 时有意义；CNB 等自定义镜像地址不会被代理改写）。
- `--no-modify-path` / 不设置 PATH 改写：安装脚本默认把 `$PREFIX/bin` 追加到 `~/.profile`，如需保持环境不变可加该参数。

## 3. 安装（Windows PowerShell）

```powershell
$env:DSH_VERSION = "0.2.2-rc.1"
$env:DSH_BASE_URL = "https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download"
irm https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/install.ps1 | iex
```

安装位置默认 `%LOCALAPPDATA%\Programs\dsh`（可用 `DSH_PREFIX` 覆盖），
`DSH_NO_MODIFY_PATH` 非空时不修改用户 PATH。

## 4. 手动下载与校验

```sh
TAG=v0.2.2-rc.1
BASE=https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download

curl -fLO "$BASE/$TAG/dsh-v0.2.2-rc.1-linux-x64.tar.gz"
curl -fLO "$BASE/$TAG/dsh-v0.2.2-rc.1-linux-x64.tar.gz.sha256"
sha256sum -c dsh-v0.2.2-rc.1-linux-x64.tar.gz.sha256
```

Windows 产物为 `dsh-v0.2.2-rc.1-win-x64.zip`（附同名 `.sha256`）。

产物命名规则：`dsh-v<版本>-<平台>-<架构>.<ext>`，平台当前仅 `linux-x64` 与 `win-x64`。

## 5. 同步机制（CNB 云原生构建）

仓库根目录 `.cnb.yml` 定义了三条触发方式，都执行同一个同步脚本 `scripts/sync-release.mjs`：

| 触发方式 | 说明 |
| --- | --- |
| `crontab: 0 1 * * *` | 每天 01:00（Asia/Shanghai）自动检查并同步 |
| `web_trigger` | 仓库页面「云原生构建」手动点击运行 |
| `api_trigger` | `cnb-rs build start -e api_trigger` / OPENAPI 触发 |

每条流水线包含三个 Stage：

| Stage | 镜像 | 作用 |
| --- | --- | --- |
| `sync-code-from-github` | `tencentcom/git-sync` | **全量提交历史同步**：拉取模式下把 GitHub 的所有分支与 tag（含完整 commit 历史）推到本仓库；`push_tags: true` 对齐 tag，`force: true` 允许覆盖 |
| `sync-release` | `node:22` | 同步 GitHub Release 的说明与附件（幂等） |
| `update-home-readme` | `node:22` | 由 `doc/INSTALL-CNB.md` 重新生成主页 `README.md` 并提交 |

同步脚本的行为：

1. **读 GitHub 走匿名访问**：源仓库是公开的，不使用任何 Token / 密钥，只依赖 GitHub 公开 API。
2. **写 CNB 用流水线内置 `CNB_TOKEN`**：构建结束自动销毁，权限限定在当前仓库。
3. **幂等**：附件名与大小一致即跳过，不重复下载、不重复上传；体积变化或新增附件才补传。
4. **不触发构建**：仓库设置里「推送自动触发」为关闭状态，只有定时任务会跑起来。
5. **提交历史**：CNB 仓库保留 GitHub 的全部 commit（当前 19 个 GitHub 提交 + CNB 侧文档提交），可用
   `GET https://api.cnb.cool/aixx.work/dsh-cli-standalone/-/git/commits?page_size=100` 查看
   （注意分页参数是 `page_size`，不是 `per_page`）。

手动触发一次：

```sh
cnb-rs build start --repo aixx.work/dsh-cli-standalone -b main -e api_trigger
cnb-rs build watch <sn> --repo aixx.work/dsh-cli-standalone
```

本地一次性同步（镜像代码 + 同步产物 + 设置触发策略）：

```sh
export CNB_TOKEN=...            # 或 cnb-rs auth login
bash scripts/sync-cnb.sh --repo aixx.work/dsh-cli-standalone
```

## 6. 社区可借鉴的实现

| 工具 | 用途 |
| --- | --- |
| [tencentcom/git-sync](https://cnb.cool/cnb/plugins/tencentcom/git-sync) | **官方代码同步插件**：pull 模式从 GitHub 拉取全部分支/tag/提交历史推到 CNB（本仓库用它做定时全量同步） |
| [mpgrm](https://cnb.cool/zhiqiangwang/mpgrm)（gsync 继任者） | 跨平台同步 Release 与附件，镜像 `docker.cnb.cool/zhiqiangwang/mpgrm:latest` |
| [cnbcool/attachments](https://cnb.cool/cnb/plugins/cnbcool/attachments) | 官方附件插件，在流水线里给 Release 上传 / 下载附件 |
| [git-cnb](https://cnb.cool/looc/git-cnb) | `git` 风格的 CNB 命令行扩展，可在流水线里查 Release 等信息 |
| [cnb-rs](https://cnb.wwvo.fun) | 官方社区 CLI：`release create/upload/view`、`repo settings pipeline`、`build watch` 等 |

## 7. 常见问题

**Q：安装脚本提示无法解析最新版本？**
CNB 的 Release 列表接口（`https://api.cnb.cool/<group>/<repo>/-/releases`）需要登录令牌，匿名不可用。
请显式设置 `DSH_VERSION`（见第 2 / 3 节），或先用 `DSH_ARCHIVE` 走本地归档安装。

**Q：下载 404？**
确认版本号与 tag 一致（`DSH_VERSION` 不带 `v`，tag 带 `v`），并确认该版本已同步到 CNB：
<https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases>。

**Q：CNB 上的产物和 GitHub 不一致？**
定时任务每天 01:00 同步一次；也可手动触发 `web_trigger` / `api_trigger` 流水线立即同步。

**Q：能改成从 CNB 自动解析最新版吗？**
可以，但需要给版本列表接口加上可访问的令牌地址（例如自建代理或带令牌的镜像 API），
再把 `DSH_RELEASES_API_URL` 指向它。
