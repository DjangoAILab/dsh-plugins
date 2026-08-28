# tool-approval-interception-and-secrets — DSH 的「工具审批 / 拦截 / 密钥隔离」机制

> 一句话：DSH 已经把「在工具派发前拦截、阻塞并要求人批准、以及把 secret 与模型隔离」这三件事做成了
> **原生服务与事件**。给 agent 加「高危操作强制人工批准」或「凭证不出插件」的能力时，优先复用这些原语，
> 不要自造第二套审批状态机。本文件是 L0 事实，涉及这些能力时先查这里。

## 事实清单

证据来自 `cordis_inspect_query`（host 侧 Service / Event 目录的直接输出）。以下片段是版本
`0.1.0-rc.7` 运行时返回的契约原文。

### 1. `tools` 服务：注册 / 限制 / 守卫 / 执行

- `register(definition): () => void` — 注册工具，返回解除注册的 disposer。
- `restrict(filter): () => void` — 对当前 agent 作用域做全局工具掩码（`allow` 只留 / `deny` 移除）。
- `guard(guard: ToolGuard): () => void` — 注册**单调守卫**，挂在可扩展的 `tools/pre-execute` 瀑布之后。
  契约原文（关键）：
  > "Any matching guard **may deny by returning a reason, while no guard can force-allow a call
  > another guard denied.**"
  → 即：守卫只能「否决」，且**没有任何其他守卫能把一个已否决的调用反转放行**。这决定了「严格/只读」
  这类策略适合用 guard 做**否决层**（fail-closed），而不能用 guard 做“放行”。
- `execute(exec): Promise<ToolExecutionResult>` — 走完 pre-policy → guards → around-dispatch → post-policy
  → finalization → notification 的完整流水线。

### 2. `tools/pre-execute` 事件：派发前的统一拦截点（waterfall）

签名：`(exec: ToolExecution, next) => Promise<PreToolDecision>`。契约原文：
> "Allow, deny, or ask before dispatch. `next()` delegates to allow; **missing approval support turns
> 'ask' into denial.**"

- 这是所有工具派发前的钩子；`exec` 含工具名、已解析参数、调用方 agent。
- `ask` 依赖下游审批支持，**没有审批支持时 `ask` 自动降级为 `deny`**（fail-closed）。

### 3. `approval` 服务 + `approval/request` 事件：审批本身

- `request(req: ApprovalRequest): Promise<ApprovalOutcome>` — 请「组合的 answerers」裁决。契约原文（关键）：
  > "`'allowed-once'` is the only grant."
  → 原生审批**只授予「单次允许」**；"本 session 批准 / 允许未来"这类语义**不在原生原语里**，要靠调用方
  自维护（例如按 `sessionId` 记录已批准的代号）。
- 失败语义（fail-closed）：aborted → `'cancelled'`，answerer 缺失/抛错 → `'unavailable'`，非法返回值归一化
  为 `'unavailable'`。三条都是**否决**，不是放行。
- `request` 要求 open turn（审计对被包进 durable log 的 commit/replay 边界内）。
- **与 `userQuestions.ask` 的关键区别（已核实，源码）**：`approval.request` **没有** caller/root 闸——
  `request()`（`dsh-user-approval/lib/index.js:144`）全程没有 `CALLER_NOT_LIVE` / `DELEGATED_CALLER`
  检查，唯一 throw 是「outside an open turn」（`:146`）。被 subagent 拥有的 agent 调它**不会被
  DELEGATED_CALLER 拒绝**（`scopeTarget` 的 filter 只 admit ancestor、exclude descendant，见
  `dsh-scope/lib/index.js:327`；host 级 answerer `dsh-host-apiproxy/lib/index.js:1903` 是任何 agent
  scope 的 ancestor）。而 `userQuestions.ask` **有**该闸（`dsh-user-questions/lib/index.js:62-63`）。
  → 想「问人」用 `userQuestions`（root-only）；想「机器 allowed-once gate」用 `approval.request`
  （无 root 限制）。
- `setPolicy(agent, policy)` / `overrideOf(session)` — 切换某个 live agent 的审批策略 / 读 session 覆盖值。
- `approval/request` 事件是 waterfall：`(req, next) => Promise<ApprovalOutcome>`，返回 outcome 即认领该请求，
  否则 `next()`。这就是「组合 answerers」的挂载点。

### 4. `credentials` 服务：secret 的读写与隔离

- `resolve(ref) / describe(ref) / set(ref, value) / unset(ref)`。
- **`describe` 用于配置面，不暴露 value**；`resolve` 每次调用都实时取（不可跨操作缓存）。
- 空值 = 处处视为「未配置」（`resolve` 跳过、`describe` 报未配置）。
- 用「引用」而非「值」在代码里流转：插件只在真正建立 SSH 连接那一刻 `resolve`，值从不回传给模型。

### 5. `userQuestions.ask`：内联提问 UI

- `ask(request): Promise<AskUserQuestionAnswer>` — 向唯一 active 的 UI provider 提问并等人回答。
- 人机交互边界：只有「精确的 live runtime root」能作为 caller；被 subagent 拥有的 agent 调用会被拒
  （`DELEGATED_CALLER`），有血缘但以新 root 恢复的 session 可正常问。
- 这也是内置 `ask_user_question` 工具背后的同一个服务。

### 6. `settings` 服务：持久化配置

- `register<T>(ns, schema, options?): SettingsScope<T>` — 注册一个类型化、可版本化的 settings 命名空间
  （`get` / `update` / `mutate` / `replace`）。连接清单、代号、审查等级这类**非 secret 配置**放这里。

## 何时读

- 设计/评审任何「工具要拦截、要人工批准、要 secret 隔离」的插件能力时。
- 判断一个审批需求该走 `approval.request`（单次）、还是自维护 session 级白名单（本 session 批准）、
  还是 `guard`/`tools/pre-execute`（否决层）时。