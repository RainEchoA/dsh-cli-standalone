# Windows npm 安装 dsh 性能观察与 IOPS 基准

记录 2026-11-07 在中移云电脑（Node 24.16.0 / npm 11.13.0 / npmmirror）上的一次实测。结论：npm 安装慢在**随机 I/O 与元数据操作**，不在带宽；standalone 预解包方案正好绕开此瓶颈。

## 测试环境

- Windows 11 (10.0.22631)，16 GB RAM，云电脑虚拟磁盘（VirtIO）
- 装有云桌面管理/安全代理，疑似对新建文件做实时扫描
- registry 为 npmmirror

## 测试过程

### 1. npm 安装计时

```sh
npm install @deepseek-ai/dsh@0.2.2-rc.1 --no-audit --no-fund --timing
```

`--timing` 输出阶段分解；另以 `--ignore-scripts` 热缓存重装一次作对照。冷安装解包阶段用 `find node_modules -type f | wc -l` 间隔采样估算文件落盘速率。

### 2. 设备级 IOPS（winsat，绕过 OS 缓存）

```powershell
winsat disk -drive d -seq -read
winsat disk -drive d -ran -read
winsat disk -drive d -seq -write
```

### 3. 应用级微基准（Node 脚本）

`iops-bench.mjs`：4 GB 测试文件，4K 块，测顺序写、随机读/写 QD=1 与 QD=32，以及小文件创建/删除速率。

`iops-bench2.mjs`：24 GB 测试文件（大于 16 GB 内存，避免读缓存命中），测持续顺序读带宽与冷数据随机读 IOPS；另建 5000 文件的扁平目录测 readdir+stat 遍历速率。

```sh
node iops-bench.mjs  <测试文件路径> 4
node iops-bench2.mjs <工作目录>
```

## 结果

**npm 安装**（652 包 / 约 7 万文件）：

| 阶段 | 冷缓存 | 热缓存 + --ignore-scripts |
|---|---|---|
| 依赖解析 idealTree | 214 s | — |
| 解包落盘 unpack | 710 s（≈81 文件/s） | 仍为主耗时 |
| 生命周期脚本 | 秒级失败（见下） | 跳过 |
| 失败回滚 rollback | 362 s | — |
| **总计** | **1145 s，失败** | **813 s，成功** |

顺带发现：该机 PATH 中某个桌面应用自带的 `node.cmd` 包装脚本（通过其私有环境变量间接调用 node，该变量在应用外为空）排在真实 Node 之前，导致所有 `node` 开头的 npm 生命周期脚本 exit 9009——默认安装必失败，与 dsh 本身无关。

**磁盘基准**：

| 项目 | 结果 |
|---|---|
| winsat 顺序读 64K | 5405 MB/s |
| winsat 随机读 16K | 41.8 MB/s（≈2600 IOPS） |
| winsat 顺序写 64K | 16.9 MB/s |
| 4K 随机写 QD=32 持续 | 11.1K IOPS / 43.5 MB/s，延迟 3.1 ms |
| 顺序读 1MiB 持续（24 GB） | 1860 MB/s |
| 小文件创建 / 删除 | 1350 / 735 files/s |
| 冷递归遍历 7 万文件（find / du） | ≈400 / ≈50 files/s |

## 结论

该盘是典型的高带宽、低随机、高元数据延迟云盘：顺序读 5.4 GB/s，但随机 I/O 仅 ~42 MB/s、元数据操作比桌面 SSD 慢 1–2 个数量级。npm 安装恰好是随机写 + 元数据密集负载（7 万小文件、sha512 校验、rename 原子写），实测被放大到普通桌面 NVMe 的约 10 倍。瓶颈不在带宽，预解包的 standalone 归档把这部分开销转移到构建机，对该类环境收益明显。
