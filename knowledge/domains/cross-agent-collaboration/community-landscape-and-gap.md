# community-landscape-and-gap — 社区「跨 Agent 协作」实现调研与缺口评估

> 一句话结论：社区已有**零散的**「调外部 agent 当工具」实现，但**不存在开箱即用、完美满足
> DSH「异步 + 回call」需求的现成方案**。同步一次性调用已有现成可抄；异步+回call 的协议标准与
> DSH 原生原语都齐了，但**缺一层把外部 agent 接进 DSH 异步缝隙的 provider**，需要自己补。
> 调研时间：2026-08。（DSH 机制事实见 L0
> [tool-async-and-callback-contract](../../foundations/tool-async-and-callback-contract.md)。）

## 一、先分清社区里「跨 agent」的四类，别混淆

| 类别 | 谁当 orchestrator | 代表 | 与需求关系 |
| --- | --- | --- | --- |
| 资产互操作 | DSH（复用别家配置，不 spawn 别家 agent） | `dsh-bridges` | 无关（复用 skills/memory/hooks/MCP，不调外部 agent） |
| 反向派活 | Claude Code / Codex（把 DSH 当 worker） | `@zseven-w/dsh-crew` | 方向相反 |
| 正向同步调用 | DSH / Claude / Codex（把 codex/claude 当一次性同步工具） | `codex-as-mcp`、`@monotykamary/dsh-subagent-claude-code` | **贴合方向**，但只同步 |
| 协议标准（异步+推送） | 跨 agent 消息协议 | A2A / MCP Tasks / ACP | 提供「异步+回call」语义 |

用户要的是第 3 类（调 codex/claude 当工具）+ 第 4 类（异步+回call）的组合。

## 二、社区实现逐条（含证据）

### 1. `dsh-bridges`（yhlooo，npm `dsh-bridges`）
桥接 Claude Code / CodeBuddy / OpenCode / Codex / Pi / Gemini CLI / Cursor 的**配置资产**
（skills/commands/memory/hooks/permissions/MCP）进 DSH，让已有项目零迁移。
来源：<https://github.com/yhlooo/dsh-bridges>。**它不 spawn 外部 agent**——是资产互操作，与
「把外部 agent 当工具调」不同，别被名字误导。

### 2. `@zseven-w/dsh-crew@0.1.0-rc.1`（反向）
方向相反：从 Claude Code / Codex 派活给 DSH agent。机制 = MCP 工具 `dsh_run_worker(tier, effort, cwd)`
+ 独立 `dsh-jsonrpc-agent` runtime。**长任务的关键结论**在其 README 原文：
「CC has timeout limits on MCP calls (`MCP_TOOL_TIMEOUT` adjustable), long tasks can have
orchestrator use `dsh_spawn_worker` + `dsh_worker_result(wait_seconds)` polling」——即跨 agent 长任务的
通用解法就是 **spawn + 轮询**，与 DSH 的 jobs 轮询同构。来源：<https://github.com/ZSeven-W/dsh-crew>。

### 3. `@monotykamary/dsh-subagent-claude-code@0.1.0-rc.5`（最贴合方向，但只有 one-shot）
把 **Claude Code 做成一个 `dsh-subagent` provider**（挂进 `ctx.subagents.registerProvider`），走官方
Claude Agent SDK（依赖 `@anthropic-ai/claude-agent-sdk@0.3.220`+`@anthropic-ai/sdk@0.93.0`），不是
CLI 子进程。npm metadata 明确写 **"One-shot"**——只做一次性同步，**无 continuable / background，
即无异步、无回call**。注意：`@monotykamary/*` 是 deepseek-harness 的社区镜像（一整套 `@deepseek-ai/*`
改名重发），版本停在 rc.5；官方 rc.7 运行时里并没有这个 bundle（官方 subagent provider 只有进程内
`spawn`/`fork`）。来源：<https://www.npmjs.com/package/@monotykamary/dsh-subagent-claude-code>。

### 4. codex → MCP 一类（阻塞同步）
`codex-as-mcp`（kky42）等：MCP server 暴露 `spawn_agent(prompt)` / `spawn_agents_parallel`，底层
`codex exec --cd <cwd> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`（prompt 走
stdin 避免引号/长度问题）。**阻塞同步，无异步/回call**，且 `--dangerously-bypass-approvals-and-sandbox`
禁用了沙箱与确认（只适用于可信仓库）。同类：denysvitali/codex-mcp、@yuemingruoan/codex-mcp-server，
以及号称 async 的 `@wyrd-company/async-claude-agentsdk-mcp`。来源：
<https://github.com/kky42/codex-as-mcp>。

### 5. 协议标准（异步 + 回call 的语义来源）
- **A2A**（Google / Linux Foundation，JSON-RPC over HTTP）：<https://agent2agent.info/docs/topics/streaming-and-async/>
  给出 SSE 流式（`message/stream`/`task/status`）+ 长任务/断连场景的 **push notification**，是跨 agent
  异步+推送的标准答案。
- **MCP Tasks 扩展**（SEP-2663）：<https://modelcontextprotocol.io/extensions/tasks/overview> 给 MCP 加 task
  生命周期（createTask → 轮询 getTask / 流式 partial），同一 client 持任务——MCP 侧「异步」标准。
- **ACP（Agent Client Protocol，Zed 发起）**：agent↔client 事件流协议，作为第三种备选口径（例如
  goclaw 的 issue #189 在谈 ACP provider）。

## 三、能否「完美满足」需求？——评估

**不能。** 逐项对照 DSH 的机制事实（见 L0）：

1. **同步一次性「调 codex/claude 当工具」——已现成。** `codex-as-mcp` 可经 DSH 自带的
   `dsh-mcp-client` 直接挂；或照抄 `@monotykamary/dsh-subagent-claude-code` 的 provider 思路；再或
   最省地写一个 DSH 工具，`execute` 里 `ctx.subprocess.spawn` 跑 `codex exec` / `claude -p`，
   把 stdout 经 `output.render` 成文本块，`exec.signal`→`terminate()` 杀进程树。
2. **异步 + 回call——标准与原语都齐，但缺实现。** 协议侧 A2A（推送）、MCP Tasks（轮询）已标准化；
   DSH 侧 jobs（轮询）与 subagent settlement notice（推送）的原语已内置。但**没有任何现成实现把外部
   agent 接进这条链**：`@monotykamary/dsh-subagent-claude-code` 只 one-shot；`codex-as-mcp` 是阻塞
   `codex exec`；`dsh-crew` 的轮询是**反向**且只轮询不推送、还活在 MCP 超时（`MCP_TOOL_TIMEOUT`）阴影下。
3. **外部 agent 语义差异带来的额外缺口**：codex `exec` 一次性，历史恢复要看 session id
   （openai/codex issue#3817「non-interactive 无 session id 就 resumeless」）；Claude 有 SDK 的
   backgroundTask/async 与流式；A2A/MCP-tasks 是长连接/SSE。要映射到 DSH 的「单个 JSON 值 → 内容块」
   结果契约 + `exec.signal` 取消 + 结构化 `outputSchema`，需逐个处理。

## 四、落地 DSH 的推荐路径（最省 → 最完整）

| 目标 | 做法 | 复用 DSH 的原语 | 成本 |
| --- | --- | --- | --- |
| 同步一次性调外部 agent | 写一个 DSH 工具，spawn `codex exec`/`claude -p`，stdout→`output.render` | `ctx.subprocess.spawn`+`terminate`、`ctx.tools.register` | 最小（半天级） |
| 异步轮询（推荐起步） | 把外部 agent 跑成**后台 job**，模型 `job_output` 轮询 / `job_kill` 取消 | `dsh-jobs`（`ctx.jobs.start/read/kill`） | 低 |
| 异步推送回call（终点） | 实现 `dsh-subagent` provider 的 **continuable** 分支，agent settle 时投 settlement notice / `reportFrom` 推回父 turn | `ctx.subagents.registerProvider` + settlement delivery | 高（最贴近「回call」语义） |
| 跨进程/跨机器（进阶，可选） | provider 当 A2A / MCP-tasks 的 client，把外部任务生命周期映射到 SubagentRun/jobs | L0 里的 subprocess + subagent 缝隙 | 高 |

> 起点建议：先做「同步一次性」验证链路（codex exec / claude -p 都行），再接 jobs 做异步轮询；
> 「推送回call」若确要，最后再做 continuable settlement notice——它最重但复用 DSH 现成推送投递，
> 不用自造事件总线。
