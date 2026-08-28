# dsh-plugins — DSH 插件与内置知识库

> 本仓库承载本机对 DeepSeek Harness（DSH）的定制、扩展与内置知识库。
> 目录结构与路由规则是**强约束**，见 [`AGENTS.md`](AGENTS.md)；本文件只做导航总览。

## 三个分区

| 分区 | 放什么 |
| --- | --- |
| `plugins/manual/` | **手动维护的插件** —— 我们自己手写的代码/补丁/脚本（source of truth 在此） |
| `plugins/community/` | **三方社区插件** —— `dsh plugin add` 装的 npm 包，这里只留集成配方/记录，不 vendor 源码 |
| `knowledge/` | **内置知识库** —— 关于 DSH 机制的基础事实 / 领域知识 / 操作手册 |

## 目录树即索引

**要列出所有插件或知识？直接看目录**，本文件不维护内容清单：

```bash
ls plugins/manual plugins/community
ls knowledge/foundations knowledge/domains knowledge/runbooks
```

每个模块/知识点在自己的目录里自带 `README.md` 自述（放什么 + 何时读）。父级 README
（本文件与各级 README）只约定**结构与路由规则**，不罗列内容——那样会随增删腐化。

## 上下文路由

- 任务开始先读本 README 了解结构。
- 涉及 DSH 机制 → `knowledge/foundations/`（L0 基础事实，必读）。
- 领域性知识 → `knowledge/domains/<领域>/`（L1）。
- 具体操作步骤 → `knowledge/runbooks/<操作>/`（L2）。
- 插件相关 → 读对应模块目录的 README（`plugins/manual/` 或 `plugins/community/`）。

完整铁律见 [`AGENTS.md`](AGENTS.md)。

## 获取仓库

```bash
git clone https://github.com/DjangoAILab/dsh-plugins.git
cd dsh-plugins
```

插件均以各自目录中的 README 为准。涉及本地安装时，请从仓库根目录执行示例命令，
不要照抄维护者机器上的绝对路径。
