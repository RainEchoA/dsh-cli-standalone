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

在线安装必须显式指定版本，不隐式解析 latest。可以直接使用 Release 附带的安装脚本：

```sh
curl -fsSLO https://github.com/RainEchoA/dsh-cli-standalone/releases/download/v0.2.2-rc.1/install.sh
sh install.sh --version 0.2.2-rc.1
```

```powershell
Invoke-WebRequest -UseBasicParsing -OutFile install.ps1 https://github.com/RainEchoA/dsh-cli-standalone/releases/download/v0.2.2-rc.1/install.ps1
.\install.ps1 -Version 0.2.2-rc.1
```

仓库内的 `install.sh`／`install.ps1` 与发布产物等价：

```sh
./install.sh --version 0.2.2-rc.1
```

```powershell
.\install.ps1 -Version 0.2.2-rc.1
```

也支持完全离线的本地归档安装；校验和文件必须位于归档旁：

```sh
./install.sh \
  --version 0.2.2-rc.1 \
  --archive ./dsh-v0.2.2-rc.1-linux-x64.tar.gz
```

```powershell
.\install.ps1 `
  -Version 0.2.2-rc.1 `
  -Archive .\dsh-v0.2.2-rc.1-win-x64.zip
```

Linux 默认安装到 `~/.local/share/dsh/versions/<version>`，shim 为 `~/.local/bin/dsh`，必要时更新 `~/.profile`。Windows 默认安装到 `%LOCALAPPDATA%\Programs\dsh`，shim 位于其 `bin\dsh.cmd`，必要时更新用户 PATH。

使用 `--prefix`／`-Prefix` 可改变安装位置；`--no-modify-path`／`-NoModifyPath` 禁止修改 PATH 配置，并在输出中给出手工配置路径。已存在的同版本目录不会被覆盖。

## 安装器回归测试

```sh
node tests/installer-regression.mjs \
  --archive dist/dsh-v0.2.2-rc.1-linux-x64.tar.gz \
  --version 0.2.2-rc.1
```

覆盖：缺少校验和、归档被篡改、归档与版本不匹配、路径含空格的有效安装、shim 执行、重复版本拒绝且不删除旧目录、篡改后重装保持旧启动器可用，以及 Linux PATH 写入／Windows 禁止 PATH 修改。

## GitHub Actions

`.github/workflows/ci.yml`（main 分支 push、pull request、手动触发）包含：

- Ubuntu 与 Windows 独立构建、解包验证、Web GUI 请求和安装器正负分支；
- CentOS 8 容器内无预装 Node.js 的安装与再次解包验证；
- 上传带 SHA-256 的平台归档为 workflow artifact。

`.github/workflows/release.yml`（`v*` 标签 push、手动触发）复用同一套构建与验证，全部通过后将产物发布到 GitHub Release，见“发布”。

CentOS 8 容器只证明 **glibc 2.28 用户空间兼容性**。容器使用宿主机内核，因此不能据此宣称已验证 CentOS 8 的 4.18 内核或 Landlock 降级行为。

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
- 本地归档没有校验和：硬失败，不跳过验证。
- 归档包含绝对路径或 `..` 路径项：硬失败。
- 安装后版本输出不符：硬失败。
- 下载失败：返回非零，不自动切换镜像或版本。

## 许可证

本仓库打包与安装脚本使用 MIT。DeepSeek Harness、Node.js 及依赖分别遵循其原始许可证；归档保留 Node.js LICENSE、npm 包元数据及随依赖发布的许可证文件。
