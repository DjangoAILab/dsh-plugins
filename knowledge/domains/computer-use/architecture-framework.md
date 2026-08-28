# architecture-framework — 浏览器 / computer-use 整体框架与决策记录（设计稿，非 L0 事实）

> 这是**设计决策 + 路线图**（ADR 风格），不是 DSH 机制事实——机制事实在 `../../foundations/`，领域对比在
> 本目录 [`opencli-vs-codex.md`](opencli-vs-codex.md) / [`community-landscape.md`](community-landscape.md) /
> [`tool-vs-subagent.md`](tool-vs-subagent.md) / [`observation-control-taxonomy.md`](observation-control-taxonomy.md)。
> 本文回答四个问题：①要不要拆插件；②拆几个；③工具 vs 子代理怎么决策；④「子代理」该硬约束还是软推荐。
> 分级信源规则见 [`README.md`](README.md)。

## 0. 需求摘要（functional + non-functional）

- **目标**：让 DSH 能（1）操作浏览器本身；（2）做视觉 computer use；（3）未来扩展到远程控制 / 本机 GUI 控制。
- **NFR（明确写进设计，否则不成立）**：
  - 安全 fail-closed：高危/敏感动作必须可拦截、可审批、可禁用（L0 `tool-approval-interception-and-secrets.md`）；
  - 成本有界：观察模态决定 token 成本，长程流程必须能隔离/封顶上下文（复用
    [`tool-vs-subagent.md`](tool-vs-subagent.md) 的结论）；
  - 确定性可回归：浏览器操作要能写成可测命令，而不是「每次现看现点」无回归（`opencli-vs-codex.md` §四）；
  - 可回滚：每个能力独立启用/禁用（呼应本仓库 `dsh-external-agents` 「可回滚」「解耦」约束，见 AGENTS.md §七）。

## 1. 总体分层框架

```
L0 复用（DSH host 已有，别重造）
   approval / guard / tools.pre-execute / credentials / userQuestions / jobs / subagents / subprocess / MCP client
        ▲
L1 两个插件（本文核心）
   dsh-browser-control  —— 浏览器：DOM 快照优先 + 登录态复用 + 短交互工具集
   dsh-computer-use     —— 视觉整机：屏幕观察 + 辅助功能动作 + 更高审批门槛
        ▲
L2 决策层（容量路由 = 软推荐）
   工具(内联) / 后台 job / subagent 的路由启发式 → 落在工具描述与 skill，不硬编码
        ▲
L3 未来（本地验证后再做）
   远程/托管沙箱（Codex-cloud 式）、跨机控制、反检测整合
```

**原则**：L0 全部复用 DSH 原生原语；L1 只补 DSH 缺的那层「浏览器/屏幕 driver + 审批适配」；L2 是「软策略」
不是新组件；L3 是「先跑通本地、再谈远程」的克制路线（避免为没到的需求提前抽象）。

## 2. ADR-1：拆成两个插件（`dsh-browser-control` vs `dsh-computer-use`）

**决策：拆。** 浏览器操控与视觉 computer use 是两个插件，不是一个。

| 维度 | 浏览器（DOM/Cdp） | 视觉 computer use |
| --- | --- | --- |
| 观察模态（taxonomy 轴一） | 结构化快照，token 便宜、确定性高 | 截图，token 贵、定位漂移 |
| 风险面 | 低～中（网页动作、登录态、表单） | 高（整桌面、剪贴板、前台接管） |
| 系统依赖 | CDP/扩展/daemon，跨平台 | macOS 屏幕录制+辅助功能 / Windows 前台 |
| 审批粒度 | 按「动作类型/域名」审批 | 按「app/窗口」审批 + 权限弹窗不可自动批准 |
| 社区可抄 | Playwright MCP / Chrome DevTools MCP / OpenCLI | CUA / open-computer-use / OpenCUA |
| 授予与禁用 | 用户可能只想要网页自动化 | 用户可能永远不想开整机控制 |

**理由**：这四组差异落在**不同的观察模态、不同的风险面、不同的系统依赖**上；拆开才能让两个能力
**独立授权、独立禁用、独立升级与回滚**（满足 NFR「可回滚/最小权限」）。把它们绑成一个插件，等于强制
「想要网页自动化的人」同时暴露整机控制能力，违背最小权限。

**负作用与缓解**：两者共享「观察→定位→动作→重观察」的闭环与「敏感动作审批适配」逻辑。v1 **不抽共享库**
（避免过早抽象、避免把一个稳定成本摊到两个还在变的接口上）；等两条都跑通、且重复确已堆积，再抽一个
thin 的 `dsh-gui-driver-utils`（观察日志/审批适配器/会话与 tab 租约），抽取以「重复 ≥ 3 次」为触发线。

## 3. ADR-2：工具 vs 子代理 —— 「何时」已定，「如何编码」见 ADR-3

「什么场景该用工具、什么场景该派子代理/后台」的判据与决策表，**single source of truth 在
[`tool-vs-subagent.md`](tool-vs-subagent.md) §五**，这里不复制。只补两条架构结论：

1. 决策输入只有四个变量：**观察模态的 token 成本、是否要人（登录/2FA/审批）、任务是否长程探索、
   是否要流式/持续输出**。缺任何变量的上下文都达不到「可决策」。
2. 「工具 vs 子代理」是**容量/结构的决策，不是安全决策**——它回答「怎么省上下文、怎么编排」，不回答
   「允不允许做」。因此它的实现方式必须是**软的路由启发式**，而不是安全硬闸（→ ADR-3）。

## 4. ADR-3：硬约束 vs 软推荐 —— 双轨，按「安全 / 容量」分

**决策：双轨。安全与权限用硬约束（fail-closed）；容量与上下文用软推荐（给默认 + 可覆盖）。拒绝「一刀切」。**

### 4.1 为什么要硬约束安全/权限

- DSH 原语本身就是 fail-closed：`guard` **只能否决**（"no guard can force-allow"）、`tools/pre-execute`
  的 `ask` 在无审批支持时**降级为 deny**、`approval.request` **只授单次允许**（L0
  `tool-approval-interception-and-secrets.md`）。所以「敏感动作要审批」天然是硬约束，插件要做的**只是
  把「哪些动作敏感」声明进去**，而不是自造可绕过的软开关。
- 反例（社区的教训）：`codex-as-mcp` 一类为省事用 `--dangerously-bypass-approvals-and-sandbox`，把**安全**
  降成了软开关（见 <https://github.com/kky42/codex-as-mcp>），是本仓库 `dsh-external-agents` 明令避免的
  模式（AGENTS.md §七「非交互不等于无沙箱」）。

**落点**（这两个插件都遵守）：工具集最小化；敏感动作（点击、提交、涉及登录/支付/个人信息）挂
`tools/pre-execute` 拦截 + `approval.request` 审批；登录态/凭证走 `credentials` 服务，值**不回传模型**；
沙箱边界与 token 上限作为部署者可见的硬配置，**不给模型绕过入口**。

### 4.2 为什么要软推荐容量/上下文

- **模型比规则更懂任务性质**：长程 vs 一次性、探索 vs 定向，是在**运行时**才知道的，硬编码 if-else 会
  变成脆弱的穷举。【L1】Anthropic《Effective context engineering》明确反对「在 prompt 里 hardcode 复杂
  脆弱的逻辑」这一极端，主张停在「right altitude」（见 <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>）。
- **DSH 工具契约的形态决定它只能是参数**：工具契约是同步 one-shot、无流式（L0
  `tool-async-and-callback-contract.md` 事实一），所以「这次走内联还是后台」**只能**表达成工具参数
  （如 `run_in_background`）让模型按任务选——这正是 `dsh-external-agents` 已采用的做法：`run_in_background`
  是软参数，而 `-s workspace-write` 沙箱是**硬默认**、模型不能改（见 `plugins/manual/dsh-external-agents/README.md`）。

**落点**（软推荐的三处）：

| 编号 | 软推荐内容 | 载体 | 可否被模型覆盖 |
| --- | --- | --- | --- |
| S1 | 短交互当工具 / 长程走后台 job 或 subagent | 工具描述里的使用指引 + 路由 skill | 可（模型自判） |
| S2 | 观察模态优先 DOM 快照、截图兜底 | 工具描述 + taxonomy 引用 | 可（部分页面无 DOM 才截图） |
| S3 | 「默认拆子任务」的 deep-dive 深度、摘要长度 | skill / 父 prompt 引导 | 可 |

**一句话原则**：**危险的事（什么能点、什么要问人、凭证、沙箱）= 硬约束；贵的事（多少 token、拆不拆、
多深）= 软推荐。** 用户问的「子代理硬约束还是软推荐」——子代理属于「贵的事/容量」，**默认软推荐**；
只有它的**安全属性**（子 agent 内 `userQuestions.ask` 被 DELEGATED_CALLER 拒、审批边界）才是硬约束
（见 [`tool-vs-subagent.md`](tool-vs-subagent.md) §四）。

## 5. 路线图（克制、可回滚、每步有验证）

| 阶段 | 交付 | 复用原语 | 验证 | 回滚 |
| --- | --- | --- | --- | --- |
| **P0 浏览器工具（短交互闭环）** | `dsh-browser-control` 工具集：DOM 快照优先（挂 Playwright MCP 最快 / 自写 CDP 工具更可控），`navigate/snapshot/click/type/extract` | MCP client 或 `ctx.subprocess`+CDP；工具经 `ctx.tools.register` | 读一个登录态页面、填一个表单、点一个按钮 | `dsh plugin remove` + 重启（同 `dsh-external-agents`） |
| **P1 长程 + 审批** | 后台 job / subagent 化长程流程；敏感动作接 `tools/pre-execute`/`approval`；"需人"留在主 agent 工具 | `ctx.jobs`（轮询）/ `ctx.subagents` continuable（推送）/ `approval` | 多页研究任务走后台，中途问 1 次人 | 停用插件即关 |
| **P2 视觉 computer use** | `dsh-computer-use` 插件：AX 快照优先 + 截图兜底 + 元素动作工具 + 可选审批（默认关）；设计已定案，见 [`accessibility-tree-drivers.md`](accessibility-tree-drivers.md) §五 | `approval`/`guard`；driver 对标 open-computer-use（QwenLM fork） | 复现一个只在 GUI 的 bug 至多 3 步 | 独立插件，单独 remove |
| **P3 远程/托管沙箱 + 跨机** | Codex-cloud 式远程浏览器/VM 控制、反检测整合 | 本地验证后才设计，暂不排期 | — | — |

**每一步都独立可停**：P2 不做不影响 P0/P1；P3 不做不影响前两段——把「本地 → 远程」的升级做成**新增插件
或新 provider**，而不是改动已上线插件的语义。

## 6. 风险与缓解

| 风险 | 来源 | 缓解 |
| --- | --- | --- |
| 上下文膨胀 / context rot | 截图与多步观察 | 硬 token 上限 + S1/S3 软推荐拆子任务（[`tool-vs-subagent.md`](tool-vs-subagent.md) §一） |
| 点击/表单误操作 | 视觉定位漂移、DOM 语义不稳 | DOM 快照优先（确定性可回归）；高危动作用审批闸 |
| 审批被绕过 | 权限腐化 | 只用 `guard`/`pre-execute`/`approval` 原语 fail-closed，不引入 bypass（ADR-3 §4.1） |
| 登录态/风控 | 复用人肉会话时风控误伤 | 浏览器插件显式区分「本机 attach（复用登录）」vs「无头沙箱」，用户可二选一；凭证走 `credentials` |
| macOS 权限依赖 | 屏幕录制/辅助功能缺失 | P2 插件 do-cat doctor 式自检（参考 open-computer-use 的 `doctor`），缺失即拒绝启动而非半残运行 |
| 前台接管竞态 | Windows 前台模式要独占 | 文档明示；默认走「后台可中断」路径，前台作为可选显式开关 |

## 7. 审批放主 agent 还是子 agent（已核实，摘 L3）

已通过源码核实（`0.1.1-rc.2` 运行时 `@deepseek-ai/dsh-user-approval` / `dsh-user-questions` /
`dsh-scope` / `dsh-host-apiproxy` 的 lib 源码）：**`approval.request` 没有 `DELEGATED_CALLER` /
`CALLER_NOT_LIVE` 闸**，与 `userQuestions.ask` 分道扬镳。两条 seam 必须分开判断（细节见
[`tool-vs-subagent.md`](tool-vs-subagent.md) §四，机制事实在
[`tool-approval-interception-and-secrets.md`](../../foundations/tool-approval-interception-and-secrets.md)）：

- **`approval.request`（机器裁决 seam）**：子 agent 内可用。`request()`（`dsh-user-approval/lib/index.js:144`）
  只要求 open turn（否则 throw `approval.request() outside an open turn`，`:146`）＋ policy ≠ `never`
  （否则 `decide()` 返 `rejected`，`:188`）＋ answerer 可达（`scopeTarget(this, req.agent)` 瀑布，
  缺 answerer → `unavailable`，`:189`）；全程没有 `agents.roots()` 检查。它认领的是「一次性 allowed-once」
  （沙箱升权 / ACP 桥接），**不是**「问人的多选项审批 UI」。
- **`userQuestions.ask`（人机问答 seam）**：只有 live runtime root 能问（`dsh-user-questions/lib/index.js:62-63`
  的 `CALLER_NOT_LIVE` + `DELEGATED_CALLER`），子 agent 内被拒。要「问人一句（登录/2FA/敏感下单）」，
  仍需在**主 agent**（或子 agent 把待确认点上抛回主 agent）。

**P1 决策**：凡「要人点击 / 输入 / 选选项」的审批走**主 agent 的 `userQuestions.ask`**（或子 agent 上抛）；
`approval.request` 可用于**子 agent 内的机器 gate**（如敏感动作的 allowed-once 沙箱升权式拦截）。
本段曾作为 L3 待核实的运行时最小实测，退化为可选验收：headless 环境无内置 answerer、policy 常为
`never`，只会返 `unavailable`/`rejected`，源码已足以定性。
