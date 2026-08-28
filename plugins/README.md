# plugins — 插件区

按「谁维护代码」分两个子目录：

| 目录 | 判定 | 例子 |
| --- | --- | --- |
| `manual/` | 我们自己手写的代码/补丁，source of truth 在本仓库 | `web-remote-access` |
| `community/` | `dsh plugin add` 装的 npm 三方包，这里只留集成配方（不 vendor 源码） | `modlens-vision` |

## 新增一个模块

1. 判定归属（`manual/` 还是 `community/`）。
2. `mkdir -p plugins/<manual|community>/<module-name>`。
3. 写该目录的 `README.md`，必须含三段：**改了什么 / 怎么生效 / 怎么回滚**。
4. **不要**在本文件或仓库根 README 里加清单条目——目录树就是索引。

## 社区插件模块的最小内容

因为源码在 npm 而不在本仓库，`community/` 模块的 README 至少写清：

- 安装命令（版本写死，如 `@liustack/modlens@3.18.1`）；
- 引擎/配置的落盘位置（如 `~/.modlens/config.json`）；
- 验证方式（`doctor` / 基准）；
- 回滚命令；
- 集成踩坑记录（带证据：源码路径+行号 / 实测输出）。
