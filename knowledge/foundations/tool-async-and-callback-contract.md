# tool-async-and-callback-contract — DSH 工具契约与「异步/回call」原语

> 一句话：让 DSH 把外部 Agent（codex / claude 等）当工具调、并且要「异步 + 回call」是否可行、
> 怎么接最省，取决于两个 DSH 不可变机制事实——①模型可见工具的注册/执行契约长什么样；②DSH
> 原生提供了哪些异步原语。本文是这两件事的权威事实（single source of truth），别处引用即可。
> 证据源：运行时 `@deepseek-ai/dsh-tools` / `dsh-jobs` / `dsh-subagent` / `dsh-subprocess`
> 的类型定义与 README，以及本仓库 `plugins/manual/dsh-notifier` 里的真实工具注册代码。

## 事实一：工具契约是「单向请求 → 一个 JSON 值 → 渲染一次」

插件经 `ctx.tools.register(definition)` 注册（`dsh-tools/lib/types/index.d.ts:603`），
`ToolDefinition`（:106）核心字段：

| 字段 | 行 | 含义 |
| --- | --- | --- |
| `parameters` | — | 模型可见参数的 JSON Schema（`dsh-notifier/src/tool-register.mjs` 的 `compileParameters` 把作者 DSL 编译成它） |
| `execute(args, exec): Promise<unknown>` | :119 | **异步**执行体，返回**一个** canonical JSON 值 |
| `output.schema` + `output.render(args, value) → ContentBlock[]` | :108 | 把 execute 的 JSON 值**一次性**渲染成模型可见内容块（Anthropic 风格 `[{type:'text',text}]`，见 notifier 的 `renderNotify`） |
| `timeoutMs?` | :139 | 协作式超时预算，`dsh-tool-call-timeout-policy` 强制；声明它 = 承诺 execute 转发 `exec.signal` |
| `isConcurrencySafe?` | :153 | 声明本调用可并发 |
| `finalizeContent?` | :131 | 对最终 model-facing content 的同步 last-mile 改写 |

**三条决定「能否异步/回call」的硬约束**：

1. **无流式、无 deferred 结果**。`execute` 的契约原文是「settle only after its owned work
   reaches quiescence」——一次调用只产出一个值、渲染一次；中途推不了部分结果，也「先返回
   任务 ID、稍后再交付结果」做不到。
2. **取消是协作式**。registry 不硬杀同进程代码，靠 `exec.signal`（AbortSignal）；已启动的
   body 会 drain 到 quiescence 才判 `ABORTED`（`cancellationResult`/`dispatchToolBody`）。
3. `ToolRunContext`（:283）的 `deferContext(context)`（:290）与 `concludeTurn()`（:299）都
   **在 execute 返回的那一刻才生效**，不能拿来「稍后异步回call」——它们是把上下文延后注入
   下一轮、或结束本轮，不是推一个晚到的结果。

## 事实二：异步原语 A —— 后台任务（dsh-jobs，轮询式）

`dsh-jobs`（服务 `ctx.jobs`）把长任务抽象成后台 job：`start(spec)→JobId` / `get` / `read`
（流式**单消费游标**）/ `kill` / `wait(id, timeoutMs)` / `onJobDone`。模型侧由 `dsh-tool-jobs`
呈现为 `job_list` / `job_output` / `job_kill` 三个工具；`bash` 的 `run_in_background:true`
走的就是这条链（返回 job id → 之后 `job_output` 轮询）。

**即：DSH 的「异步」今天 = 「spawn + 轮询」，callback 由模型反复调 `job_output`(wait) 实现，
不是推送。** 官方 README「Known Limitations」三条：流式输出只有**一个**消费游标；前台任务**不能**
事后提升为后台；契约是**进程内**的——跨进程后端必须重新设计身份/所有权/恢复/观察语义。

## 事实三：异步原语 B —— 子 agent provider 缝隙 + settlement notice（推送回call）

`dsh-subagent`（服务 `ctx.subagents`）是「把 agent 当工具调」的**公开展点**，provider 化：

- `registerProvider(name)` / `start(name, request)`（one-shot，`Promise<SubagentRun>`，`result`
  解析出 `output`/结构化 `structured`）+ `startContinuable(spec)`（持久孩子，返回 childId）/
  `followup` / `interrupt` / `reportFrom`。
- 官方 README 明确定位：**provider 决定 child「跑在本进程 / 另一进程 / future transport」**——
  这正是外部 agent（codex/claude 子进程）的唯一正确接入点。
- capabilities：`outputSchema`（结构化结果）、`depthLimit`、`toolFilter`、`persona`。
- 官方自带 provider 目前只有两个**进程内**实现：`spawn`（`dsh-subagent-spawn-in-process`，
  全新子 agent、无父历史）与 `fork`（`dsh-subagent-fork-in-process`，继承父已完成轮次）。
  **没有任何外部 agent provider**。

**真正的「推送回call」在这里**：continuable 孩子的 **settlement delivery**——孩子 settle 时，
manager 往父 agent 的 turn 流投递一条通知（「Background subagent <id> finished …」+ 孩子收尾
消息）；空闲父收到一次新 turn，忙碌父被 steer 到最近 step 边界，正在 teardown 的父走注入。另有
`reportFrom`：quiet 交付 = 注入上下文，waking 交付 = 提交一次父 turn。这就是 DSH 原生的
「异步 + 回call（push）」语义，但它眼下**只服务于进程内 subagent**。

## 事实四：接外部进程还差的既有原语（dsh-subprocess）

`dsh-subprocess`（服务 `ctx.subprocess`）是接外部 agent 的进程半场：

- `spawn(spec)` **立即返回 live handle**，`done` 在进程 close 时解析 exit facts；
- stdio `'pipe'` 交给调用方做协议帧式（README 原文点出 LSP JSON-RPC / ACP ndjson）——codex/claude
  的 CLI 或 SDK 流都能接；collect 模式 `{ maxBytes, spill? }` 缓冲有界尾部 + 可选全量落盘，
  读完仍可读（不消费）；
- `terminate()` 是**唯一**终止动词，树级升级 SIGTERM→grace→SIGKILL，且由 spec 的 abort signal
  驱动——正好把 `exec.signal`（取消）映射成「kill 外部 agent 进程树」。
- 已知限制：**SDK 自管 spawn 不经过本服务**（用 Claude Agent SDK 那种「SDK 自己 spawn」的不走
  `ctx.subprocess`；但 `codex exec` / `claude -p` 这类 CLI 子进程完全可以）。

## 结论（路由到 L1）

工具契约本身是同步的；异步靠 jobs（轮询）或 subagent settlement notice（推送）；接外部进程用
`ctx.subprocess`。要「异步 + 回call调外部 agent」，只需把外部 agent 跑进子进程、把它的生命周期
映射到 `SubagentRun`（同步）/ jobs（轮询）/ continuable 孩子（推送）三选一。社区现状与缺口评估见
`knowledge/domains/cross-agent-collaboration/`（L1）。
