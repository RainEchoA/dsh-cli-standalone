<!-- 本文件由 scripts/render-cnb-readme.mjs 基于 INSTALL-CNB.md 自动生成，请勿直接编辑 -->

> **这是 CNB 镜像仓库**（源：<https://github.com/RainEchoA/dsh-cli-standalone>）。
> 主页内容即《dsh-cli-standalone · CNB 使用与安装手册》，仅面向 CNB 用户；
> 项目本身的构建与验证口径请看源仓库的 README。

[![CNB 定时同步](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/git/latest/ci/status/crontab)](https://cnb.cool/aixx.work/dsh-cli-standalone/-/build/logs)
[![流水线配置](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/git/latest/ci/pipeline-as-code)](https://cnb.cool/aixx.work/dsh-cli-standalone/-/blob/main/.cnb.yml)
[![Latest Release](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/release)](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/release.link)
[![Star](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/star)](https://cnb.cool/aixx.work/dsh-cli-standalone)
[![Fork](https://cnb.cool/aixx.work/dsh-cli-standalone/-/badge/fork)](https://cnb.cool/aixx.work/dsh-cli-standalone)

---


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
| 同步策略 | 每天 03:00（Asia/Shanghai）定时任务自动同步 GitHub Release 产物 |

CNB 仓库是 GitHub 源仓库的**只读镜像 + 产物分发点**：代码与 tag 随源仓库同步，Release 附件由定时任务搬运，
**不在 CNB 上执行任何构建**（仓库流水线「推送自动触发」已关闭，仅保留「定时任务自动触发」）。

## 2. 安装（Linux / macOS）

安装脚本通过环境变量把下载源切到 CNB；版本解析默认读取 GitHub Pages 的静态索引，
再逐个探测 CNB 上产物是否已同步，自动选「CNB 上可用的最新版」（CNB 每天 03:00 同步，
滞后期间自动回退到已同步版本，无需显式指定版本）：

```sh
# 1) 把 Release 下载地址切到 CNB
export DSH_BASE_URL=https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download

# 2) 执行 CNB 上的安装脚本
curl -fsSL https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/install.sh | bash
```

需要钉住版本时（等价形式，注意不带 `v` 前缀）：

```sh
curl -fsSL https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/install.sh | bash -s -- \
  --version 0.2.2-rc.1 \
  --base-url https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases/download
```

其它可用环境变量（含义与 GitHub 安装方式一致）：

- `DSH_VERSION`：显式指定 dsh 版本；缺省时按上述「索引 + 探测」自动解析。
- `DSH_ARCHIVE`：本地归档离线安装，如 `dsh-v0.2.2-rc.1-linux-x64.tar.gz`。
- `DSH_CHECKSUM`：显式指定 SHA-256（缺省时若归档旁有 `.sha256` 则自动校验）。
- `DSH_PREFIX`：安装前缀，默认 `$HOME/.local`（可执行文件落在 `$HOME/.local/bin/dsh`，版本目录在 `$HOME/.local/share/dsh/versions/<版本>`）。
- `DSH_RELEASES_JSON_URL`：版本索引 JSON 地址，默认 GitHub Pages 的 `releases.json`；**该地址不会被代理改写**，镜像场景可指向任何可达副本（例如自行托管在 CNB 仓库里的同步副本）。
- `DSH_GH_PROXY`：GitHub 加速代理（仅在仍走 GitHub 下载时有意义；CNB 等自定义镜像地址不会被代理改写）。

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
| `crontab: 0 3 * * *` | 每天 03:00（Asia/Shanghai）自动检查并同步 |
| `web_trigger` | 仓库页面「云原生构建」手动点击运行 |
| `api_trigger` | `cnb-rs build start -e api_trigger` / OPENAPI 触发 |

### 页面自定义按钮

在 **代码 → 分支详情页（main）** 顶部可直接点击（配置见 `.cnb/web_trigger.yml`）：

| 按钮 | 事件 | 作用 |
| --- | --- | --- |
| 立即同步 GitHub 产物 | `web_trigger_sync` | 全量：代码镜像 + Release 产物 + 主页 README（默认按钮） |
| 仅同步 Release 产物 | `web_trigger_sync_release` | 只搬运 Release 附件，不动代码 |
| 刷新主页 README | `web_trigger_readme` | 用 `doc/INSTALL-CNB.md` 重新生成主页 README |

> 按钮仅在「代码-分支详情页」显示；需要有仓库写权限才能触发。

每条流水线包含两个 Stage：

| Stage | 镜像 | 作用 |
| --- | --- | --- |
| `sync-code-from-github` | `node:22` | 跑 `scripts/sync-code-from-github.sh`：镜像 GitHub 的分支、tag、完整提交历史；在 main 之上追加一次主页 `README.md` 生成提交 |
| `sync-release` | `node:22` | 同步 GitHub Release 的说明与附件（幂等） |

> **为什么不用 `tencentcom/git-sync` 的 pull 模式**：它内部是 `git pull --rebase`，会把 CNB 侧那条
> 「docs: 更新 CNB 主页 README」提交重放到 GitHub 历史之上。而 `README.md` 在两边本就是有意不同的
> （GitHub 放项目说明，CNB 放本手册生成的内容），只要 GitHub 侧动过 README，rebase 必然 `CONFLICT`，
> 后续 Stage 全部 skipped。现在改为「以 GitHub main 为基线重建 main」，CNB main 恒等于
> 「GitHub main + 1 个 README 生成提交」，无分叉、无冲突。

同步脚本的行为：

1. **读 GitHub 走匿名访问**：源仓库是公开的，不使用任何 Token / 密钥，只依赖 GitHub 公开 API。
2. **写 CNB 用流水线内置 `CNB_TOKEN`**：构建结束自动销毁，权限限定在当前仓库。
3. **幂等**：附件名与大小一致即跳过，不重复下载、不重复上传；体积变化或新增附件才补传。
   代码镜像同样幂等——CNB 侧已与 GitHub 一致时不会产生新的 README 提交。
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
| [tencentcom/git-sync](https://cnb.cool/cnb/plugins/tencentcom/git-sync) | 官方代码同步插件，支持 push / rebase / pull 三种模式；**本仓库未使用**（pull 模式在「两边 README 有意不同」的场景下会反复冲突） |
| [.cnb/web_trigger.yml](https://docs.cnb.cool/zh/build/web-trigger.html) | 仓库页面自定义按钮（手动触发流水线） |
| [mpgrm](https://cnb.cool/zhiqiangwang/mpgrm)（gsync 继任者） | 跨平台同步 Release 与附件，镜像 `docker.cnb.cool/zhiqiangwang/mpgrm:latest` |
| [cnbcool/attachments](https://cnb.cool/cnb/plugins/cnbcool/attachments) | 官方附件插件，在流水线里给 Release 上传 / 下载附件 |
| [git-cnb](https://cnb.cool/looc/git-cnb) | `git` 风格的 CNB 命令行扩展，可在流水线里查 Release 等信息 |
| [cnb-rs](https://cnb.wwvo.fun) | 官方社区 CLI：`release create/upload/view`、`repo settings pipeline`、`build watch` 等 |

## 7. 常见问题

**Q：安装脚本提示无法解析最新版本？**
版本解析默认读取 GitHub Pages 的静态索引（`https://rainechoa.github.io/dsh-cli-standalone/releases.json`，匿名可达，不依赖任何登录接口），再探测 CNB 上产物是否已同步。
若运行环境访问不到 github.io，可把 `DSH_RELEASES_JSON_URL` 指向任意可达的索引副本，或显式设置 `DSH_VERSION` 绕开索引（见第 2 / 3 节）。

**Q：下载 404？**
确认版本号与 tag 一致（`DSH_VERSION` 不带 `v`，tag 带 `v`），并确认该版本已同步到 CNB：
<https://cnb.cool/aixx.work/dsh-cli-standalone/-/releases>。自动解析只会选中探测（HEAD 等价的 `.sha256` 请求返回 200）确认存在的版本，正常不会出现「解析成功但下载 404」。

**Q：CNB 上的产物和 GitHub 不一致？**
定时任务每天 03:00 同步一次（GitHub 侧扫描/构建在 21:00 之后进行，CNB 侧等其结束再搬运产物）；
滞后期间安装脚本会自动装「CNB 上已同步的最新版」，也可手动触发 `web_trigger` / `api_trigger` 流水线立即同步。

**Q：能完全脱离 GitHub 做版本解析吗？**
可以：`releases.json` 是随每次 Release 生成的静态文件，把它同步到 CNB 仓库（如提交到仓库根目录，
由 `sync-release` 阶段顺带搬运），再把 `DSH_RELEASES_JSON_URL` 指向
`https://cnb.cool/aixx.work/dsh-cli-standalone/-/git/raw/main/releases.json` 即可。
