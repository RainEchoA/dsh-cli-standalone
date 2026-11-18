# dsh-cli-standalone

面向 DeepSeek Harness `dsh` CLI + Web GUI 的独立运行时打包实验。仓库不复制上游 monorepo，而是把指定版本的 `@deepseek-ai/dsh` npm 发布包、生产依赖闭包和固定官方 Node.js 运行时组装成 Linux／Windows 归档。最终用户不需要预装 Node.js、npm、pnpm 或 tsx。

> 当前状态：开发验证阶段。GitHub Actions 通过不代表已经覆盖真实生产推理、完整终端交互、所有插件或所有 Windows 版本；具体边界见“验证口径”。

## 平台与固定版本

- dsh：`0.2.2-rc.1`
- Node.js：`24.22.2`，从 `nodejs.org` 下载并核对官方 SHA-256
- Linux：x86_64、glibc ≥ 2.28
- Windows：x64、Windows 10 1809／Server 2019 或更新版本
- 不在当前范围：musl、arm64、跨操作系统收集原生二进制、SEA 单文件

## 构建

构建机需要 Node.js ≥ 24.9、npm、curl 和 tar。目标平台必须与构建主机一致；禁止在 Linux 上生成声称包含 Windows 原生依赖的包。

```sh
node scripts/build-standalone.mjs \
  --version 0.2.2-rc.1 \
  --node-version 24.22.2 \
  --platform linux \
  --output-dir dist
```

Windows 使用 `--platform win`。npm 安装脚本采用项目内白名单并启用 `--strict-allow-scripts`；白名单外出现新的生命周期脚本会使构建失败。构建器还检查 Koffi、node-pty、Linux node-addon-system 的实际文件并运行 `scripts/native-probe.mjs`，不使用“安装命令返回成功”代替原生功能验证。

产物：

```text
dsh-v0.2.2-rc.1-linux-x64.tar.gz
dsh-v0.2.2-rc.1-linux-x64.tar.gz.sha256
# 或
dsh-v0.2.2-rc.1-win-x64.zip
dsh-v0.2.2-rc.1-win-x64.zip.sha256
```

## 验证实际归档

```sh
node scripts/verify-standalone.mjs \
  --archive dist/dsh-v0.2.2-rc.1-linux-x64.tar.gz \
  --version 0.2.2-rc.1 \
  --platform linux
```

验证器重新解包，并执行：

1. `dsh --version`、`dsh --help`、`dsh web --help`；
2. 在 `PATH` 前置会立即报错的假 `node`／`npm`／`pnpm`，确认启动器没有误用系统工具；
3. 启动 `dsh web --no-open --host 127.0.0.1 --port 0`，读取实际监听 URL，携带启动 cookie 请求 Web GUI，并检查 HTML 响应；
4. 枚举归档中的 `.node` 原生模块，保留可复查清单；
5. 实际加载 Koffi、node-pty 并完成 shell 退出回环；Linux 另测 flock 互斥／释放、glibc 二进制选择及 Landlock 探针，支持时执行隔离写入世界证明。

Windows 使用对应 ZIP 和 `--platform win`。

## 安装

### Windows 一行安装

与 `powershell -File .\install.ps1` 调用的是同一个脚本（取自本仓库 main 分支，不依赖 release 资产副本）。不显式指定版本时，读取[静态版本索引 `releases.json`](https://rainechoa.github.io/dsh-cli-standalone/releases.json)（每次 Release 后由 Pages 工作流刷新），按 semver 优先级从新到旧逐个探测下载源上产物是否实际存在（排除 dev/alpha 前置版本，规则与「每日版本扫描」一致），取「下载源上可用的最新版」——镜像同步滞后时自动回退到已同步的最新版，而不是解析出一个还下载不了的版本；显式指定始终优先：

```powershell
irm https://raw.githubusercontent.com/RainEchoA/dsh-cli-standalone/main/install.ps1 | iex
```

可用环境变量（全部可选）：

- `DSH_VERSION`：显式 dsh 版本（不带 `v` 前缀）；缺省时自动解析最新 release。
- `DSH_ARCHIVE`／`DSH_CHECKSUM`：离线安装本地归档／显式 SHA-256（校验可选：有归档旁 `.sha256` 或显式值则校验，否则跳过并提示）；未设 `DSH_VERSION` 时版本从归档文件名解析。
- `DSH_PREFIX`：安装位置，默认 `%LOCALAPPDATA%\Programs\dsh`。
- `DSH_NO_MODIFY_PATH`：非空时禁止修改用户 PATH。
- `DSH_BASE_URL`／`DSH_RELEASES_JSON_URL`：release 下载／版本索引 JSON 的地址（镜像、气隙环境）。版本索引默认值是每次 Release 后刷新的 GitHub Pages 静态 JSON，不依赖 GitHub API。
- `DSH_GH_PROXY`：GitHub 加速代理（如 `https://api.gitproxy.dev`）；把默认 GitHub 地址（安装脚本、版本 API、release 下载）重写为 `<代理>/<原 URL>`，显式指定的 URL 参数不被重写。
- `DSH_NO_DESKTOP_SHORTCUT`：非空时不创建桌面快捷方式（`-NoDesktopShortcut` 等价）。
- `DSH_DESKTOP_DIR`：桌面快捷方式的输出目录，默认取系统用户桌面文件夹。

版本解析读取 GitHub Pages 的静态 JSON（`rainechoa.github.io`），下载走 `--base-url`；两者都需可达，气隙环境可把上述地址指向镜像。GitHub 直连受限时可用加速代理（外层 `irm` 的 URL 需自行加代理前缀；版本索引地址不会被代理改写，镜像场景可直接把 `DSH_RELEASES_JSON_URL` 指向可达的 JSON 副本）：

```powershell
$env:DSH_GH_PROXY = 'https://api.gitproxy.dev'
irm "$env:DSH_GH_PROXY/https://raw.githubusercontent.com/RainEchoA/dsh-cli-standalone/main/install.ps1" | iex
```

### Windows 脚本安装

Release 附带的 `install.ps1` 与仓库内副本等价，直接使用 Release 副本：

```powershell
Invoke-WebRequest -UseBasicParsing -OutFile install.ps1 https://github.com/RainEchoA/dsh-cli-standalone/releases/download/v0.2.2-rc.1/install.ps1
.\install.ps1 -Version 0.2.2-rc.1
```

版本解析规则与一行安装相同，`-Version` 可省略（自动解析最新 release）；离线归档可省 `-Version`，版本按文件名推断：

```powershell
.\install.ps1                                        # 在线，自动解析最新 release
.\install.ps1 -Version 0.2.2-rc.1                    # 在线，显式版本
.\install.ps1 -GitHubProxy https://gitproxy.dev      # 在线，走 GitHub 加速代理
.\install.ps1 -Archive .\dsh-v0.2.2-rc.1-win-x64.zip # 离线，版本从归档名解析
```

### Linux

与 Windows 相同的版本解析规则：`--version` 可省略，不显式指定时读取静态版本索引、排除 dev/alpha，并按 semver 从新到旧探测下载源，取实际可用的最新版；离线归档按文件名推断版本。可以直接使用 Release 附带的安装脚本：

```sh
curl -fsSLO https://github.com/RainEchoA/dsh-cli-standalone/releases/download/v0.2.2-rc.1/install.sh
sh install.sh --version 0.2.2-rc.1
```

仓库内的 `install.sh` 与发布产物等价，常用形式：

```sh
./install.sh                                                 # 在线，自动解析最新 release
./install.sh --version 0.2.2-rc.1                            # 在线，显式版本
./install.sh --github-proxy https://gitproxy.dev             # 在线，走 GitHub 加速代理
./install.sh --archive ./dsh-v0.2.2-rc.1-linux-x64.tar.gz    # 离线，版本从归档名解析
curl -fsSL https://raw.githubusercontent.com/RainEchoA/dsh-cli-standalone/main/install.sh | sh
```

`--version`／`--base-url`／`--releases-json-url`／`--github-proxy`／`--prefix` 缺省时依次读取环境变量 `DSH_VERSION`／`DSH_BASE_URL`／`DSH_RELEASES_JSON_URL`／`DSH_GH_PROXY`／`DSH_PREFIX`（`curl ... | sh` 场景用环境变量传参）。代理行为与 Windows 一致：外层 `curl` 的 URL 需自行加代理前缀；解析走不通时显式 `DSH_VERSION` 可绕开索引读取。

完全离线的本地归档安装（归档旁的 `.sha256` 或 `--checksum` 存在时校验，二者皆无则跳过验证并提示）：

```sh
./install.sh \
  --archive ./dsh-v0.2.2-rc.1-linux-x64.tar.gz
```

```powershell
.\install.ps1 `
  -Archive .\dsh-v0.2.2-rc.1-win-x64.zip
```

Linux 默认安装到 `~/.local/share/dsh/versions/<version>`，shim 为 `~/.local/bin/dsh`，必要时更新 `~/.profile`。Windows 默认安装到 `%LOCALAPPDATA%\Programs\dsh`，shim 位于其 `bin\dsh.cmd`，必要时更新用户 PATH；Windows 安装还会生成 Git Bash 可直接调用的无扩展名 shim（`bin\dsh`，bash 不做 PATHEXT 扩展）和桌面快捷方式 `dsh.lnk`（双击启动 `dsh web`），后者可用 `-NoDesktopShortcut`／`DSH_NO_DESKTOP_SHORTCUT` 关闭、用 `-DesktopDir`／`DSH_DESKTOP_DIR` 改放其它目录。

使用 `--prefix`／`-Prefix` 可改变安装位置；`--no-modify-path`／`-NoModifyPath` 禁止修改 PATH 配置，并在输出中给出手工配置路径。已存在的同版本目录不会被覆盖。

## 卸载

安装器不写注册表、不装系统服务，卸载即删除其产物（用了 `--prefix`／`-Prefix` 时按实际位置替换路径）：

- Windows：删除 `%LOCALAPPDATA%\Programs\dsh` 目录；从用户 PATH 移除 `...\Programs\dsh\bin` 条目（系统属性 → 环境变量，或参考上文命令）；删除桌面 `dsh.lnk`。
- Linux：删除 `~/.local/share/dsh` 和 `~/.local/bin/dsh`；打开 `~/.profile` 删除 `# dsh-cli-standalone user PATH` 注释行及其下一行 `export PATH=...`。

## 安装器回归测试

```sh
node tests/installer-regression.mjs \
  --archive dist/dsh-v0.2.2-rc.1-linux-x64.tar.gz \
  --version 0.2.2-rc.1
```

覆盖：缺少校验和、归档被篡改、归档与版本不匹配、路径含空格的有效安装、shim 执行、重复版本拒绝且不删除旧目录、篡改后重装保持旧启动器可用、Linux PATH 写入／Windows 禁止 PATH 修改，以及 Git Bash shim 内容与执行、桌面快捷方式生成与 `-NoDesktopShortcut` 反向用例。

## GitHub Actions

`.github/workflows/ci.yml`（main 分支 push、pull request、手动触发）包含：

- Ubuntu 与 Windows 独立构建、解包验证、Web GUI 请求和安装器正负分支；
- CentOS 8 容器内无预装 Node.js 的安装与再次解包验证；
- 上传带 SHA-256 的平台归档为 workflow artifact。

`.github/workflows/release.yml`（`v*` 标签 push、手动触发）复用同一套构建与验证，全部通过后将产物发布到 GitHub Release，见“发布”。

`.github/workflows/daily-version-scan.yml`（定时每天 21:00 北京时间、手动触发）扫描 npm 上 `@deepseek-ai/dsh` 的最新版本（排除 dev/alpha，semver 优先级取最大）：发现新的**稳定版**时自动触发 `release` 工作流发布（失败次日自动重试）；发现 rc/beta 时创建或更新跟踪 issue 等待人工确认。

CentOS 8 容器只证明 **glibc 2.28 用户空间兼容性**。容器使用宿主机内核，因此不能据此宣称已验证 CentOS 8 的 4.18 内核或 Landlock 降级行为。

## Release 版本页面

每次 Release 成功后，工作流会通过 GitHub Pages 发布静态版本索引，页面访问时不依赖 GitHub API。也可以在 Actions 页面手动运行 `pages` 工作流，直接刷新索引而无需重新构建或发布安装包：

- 人工查看：<https://rainechoa.github.io/dsh-cli-standalone/>
- 程序读取：<https://rainechoa.github.io/dsh-cli-standalone/releases.json>

JSON 包含 `versions` 版本号数组及 `releases` 详细信息，保留所有非草稿 Release（包括 rc/beta 预发布），可供 CNB 等没有公开 Release 查询接口的平台使用。安装脚本已直接消费这份索引：候选版本按 semver 排序后逐个探测 `<base-url>/v<版本>/…sha256`（200 = 镜像已同步，404 = 尚未同步，其余错误硬失败），选中「下载源上可用的最新版」：

```sh
curl -fsSL https://rainechoa.github.io/dsh-cli-standalone/releases.json
```

首次部署前需在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。本地可用 `npm run build:release-page` 重新生成到 `dist-pages/`，用 `npm run test:release-page` 验证分页、草稿过滤和页面输出。

## 发布

发布走 GitHub Actions，不在本机手工上传产物。两种触发方式：

```sh
git tag v0.2.2-rc.2
git push origin v0.2.2-rc.2
```

或在仓库的 Actions 页面手动运行 `release` 工作流并输入版本号（如 `0.2.2-rc.2`）；手动触发会自动创建 `v<version>` 标签。

发布前，工作流会完整执行与 CI 相同的构建与验证（两个平台独立构建、解包验证、Web GUI 请求、安装器正负分支、CentOS 8 容器复验、发布前再次核对 SHA-256），任何一步失败都不会创建 Release。重跑同一版本是安全的：同名资产会被覆盖更新。

Release `v<version>` 包含以下资产，与安装脚本的下载约定一致：

```text
dsh-v<version>-linux-x64.tar.gz      + .sha256
dsh-v<version>-win-x64.zip           + .sha256
install.sh
install.ps1
```

版本号带 `-`（如 `0.2.2-rc.1`）会自动标记为 prerelease。

## 防静默失效约束

- 目标平台与构建机不一致：硬失败。
- 请求版本与 npm 实际安装版本不一致：硬失败。
- Node.js 或 dsh 归档校验和错误：硬失败，不创建安装前缀。
- 离线归档旁存在 `.sha256` 或显式给出校验和时：必须校验，错误硬失败；两者都缺省时跳过验证，并在输出中明示（不静默跳过）。
- 归档包含绝对路径或 `..` 路径项：硬失败。
- 安装后版本输出不符：硬失败。
- 下载失败：返回非零，不自动切换镜像或版本。
- `-File` 调用下任何未处理异常都显式 `exit 1`（不依赖 PowerShell 5.1 有缺陷的异常退出码）；`irm|iex` 下原样抛出，不退出宿主会话。
- 版本自动解析（未指定 `-Version` 时）：索引 JSON 不可读、排除 dev/alpha 后无候选版本、或探测出错（非 404 的 HTTP 错误/网络错误）：硬失败；镜像滞后导致候选版本在下载源上 404：按 semver 从新到旧回退到实际可用的版本；镜像上没有任何已索引版本：硬失败。
- 离线归档文件名无法推断版本，或平台与当前系统不符：硬失败。

## 性能实验记录

- `doc/iops-benchmark.md`：中移云电脑上 npm 安装 dsh 的计时分解与磁盘 IOPS 基准测试过程（winsat + Node 微基准，脚本同目录）。结论：此类高带宽、低随机、高元数据延迟的虚拟盘会把 npm 安装放大约 10 倍，瓶颈不在带宽，standalone 预解包方案对该类环境收益明显。

## 许可证

本仓库打包与安装脚本使用 MIT。DeepSeek Harness、Node.js 及依赖分别遵循其原始许可证；归档保留 Node.js LICENSE、npm 包元数据及随依赖发布的许可证文件。
