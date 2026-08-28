# tool-vs-subagent — 操作浏览器「做成工具」还是「拆成子任务」？（问题三）

> 一句话：**没有唯一答案，取决于四个变量——观察模态的 token 成本、是否要人审批、任务是否长程探索、
> 是否需要流式/持续输出**。理论依据是「context 是有限资源」，DSH 的具体约束则来自它的工具契约与
> 人机提问边界。结论是**分层做**：短交互当工具、长程探索拆子任务。分级信源规则见
> [`README.md`](README.md)。

## 一、理论依据：context 是有限资源（这是「拆上下文」的根）

【L1，Anthropic 工程博客《Effective context engineering for AI agents》，2025-09-29，
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>】

- 原文把 context 定义为「采样时喂进 LLM 的 token 集合」，并给出三点硬约束：
  1. **attention budget（注意力预算）**：像人工作记忆有限，每进一个新 token 都消耗预算；
  2. **context rot**：needle-in-a-haystack 类研究表明，token 越多、模型**准确回忆**能力越降；
  3. **架构根因**：transformer 每 token 对每 token 都有 n² 成对关系，序列越长越稀释，且训练分布里
     短序列更常见。
- **直接结论**：慎选「最小的高信号 token 集合」，工具要「token-efficient」地返回信息。

这几条直接决定了「浏览器操作」的敏感地位：浏览器每步观察会产出**大量**新 token（尤其截图），
是最容易触发 context rot 的工具类别。

## 二、理论依据：何时拆子任务（sub-agent 隔离上下文）

【L1，同一篇博客 + 《How we built our multi-agent research system》，
<https://www.anthropic.com/engineering/built-multi-agent-research-system>】

- 博客原文（关于 sub-agent 架构）：
  > "specialized sub-agents can handle focused tasks with **clean context windows**… Each subagent
  > might explore extensively… but returns only a **condensed, distilled summary** (often 1,000–2,000
  > tokens). This approach achieves a clear **separation of concerns**—the detailed search context
  > remains **isolated** within sub-agents."
- 即：**探索的脏上下文留在子 agent 里，只把摘要交回主 agent**。这正是「操作浏览器该拆子任务」的直接
  理论依据——尤其是**截图/视觉**这条路（见 taxonomy 轴一），每步上百上千 image token，留在主上下文
  会迅速触发第 1 条的 context rot。
- 【L1，GUI-agent 综述】长程 GUI 任务普遍采用 planner–actor–executor 式的**任务分解 + 记忆**，
  见 arXiv:2411.18279（Zhang et al.）；「拆子任务」在 computer use 领域不是 DSH 特有偏好，而是
  通用架构结论。

## 三、社区实践：两边都有，不是二选一

- **当「工具/capability」**：【L0】Codex 桌面版把 Computer Use 做成 plugin + MCP server + skill
  三件套（官方文档 "Turn on the Computer Use server and skill toggles"，<https://developers.openai.com/codex/computer-use>）；
  社区技能 <https://github.com/thatjuan/agent-skills/blob/main/skills/engineering/codex-computer-use/SKILL.md>
  同样以「工具化指令」暴露。→ 短交互、需要 agent 自己即时决策时，当工具最顺手。
- **当「隔离子 agent」**：【L2】<https://github.com/bmeindl/sub-agent-mcp> 的定位原文
  "spawns **isolated, off-context** opencode sub-agents"；【L1】Claude Code 官方子 agent 语义就是
  "What subagents **inherit**"（子 agent 不继承父上下文，<https://code.claude.com/docs/agent-sdk/subagents>）。
  → 长程/重探索时，社区已经用「off-context 子 agent」来避免主上下文污染。

**社区共识**：观察模态越贵（截图）越该放进隔离上下文；观察模态越便宜（DOM 快照）越能容忍当内联工具。

## 四、DSH 的具体约束（把上面落进 DSH 原语）

以下机制事实来自 L0（路径见本目录 [`README.md`](README.md) 的 L0 链接，此处只引用结论不复制原文）：

1. **工具契约是同步 one-shot**：一次调用产一个 JSON 值、渲染一次，无流式、无 deferred 结果
   （L0 `tool-async-and-callback-contract.md` 事实一）。→ 长活浏览器流程**不适合**做成同步工具；
   长活要么走后台 job（`dsh-jobs` 轮询），要么走 subagent continuable（settlement notice 推送）。
2. **人机提问边界（关键）**：`userQuestions.ask`（内置 `ask_user_question` 背后）**只有 live runtime
   root 能调，被 subagent 拥有的 agent 调用会被拒（`DELEGATED_CALLER`）**
   （L0 `tool-approval-interception-and-secrets.md` 事实 5）。→ 这意味着：
   - 需要「问你一句再继续」（如登录/2FA/敏感下单确认）的浏览器操作，**子 agent 内问不了人**；
   - 要么把它做成**主 agent 里的工具**（可 `userQuestions.ask` + 接 `approval`/`guard`/`tools/pre-execute`），
     要么子 agent 把「待确认点」**上报回主 agent**、由主 agent 问人后再回传。
3. **审批有两个 seam，别混（已核实，源码，2026-08）**：
   - `approval.request`（机器裁决 seam）只授「单次允许 allowed-once」，且**没有** `DELEGATED_CALLER` 闸：
     `request()` 只要求 open turn、policy ≠ `never`、answerer 可达（源码 `dsh-user-approval/lib/index.js:144`
     / `:188` / `:189`；缺 answerer → `unavailable`，fail-closed）。适合做敏感动作的**机器 gate**
     （沙箱升权式 allowed-once 拦截），**子 agent 内也能调**。
   - `userQuestions.ask`（人机问答 seam，即内置 `ask_user_question` 背后）**有** `DELEGATED_CALLER` 闸
     （`dsh-user-questions/lib/index.js:62-63` 的 `!agents.roots().includes(agent)`），只有 live runtime
     root 能问；要「问人一句」必须在主 agent（§四.2 不变）。
   - `guard` / `tools/pre-execute` 是**否决层**（fail-closed），与上面两个 seam 正交；浏览器敏感动作
     （点击 / 提交 / 登录 / 支付）先挂这里，再决定走机器 gate 还是问人。

> ~~待核实【L3】~~ **已核实（源码）**：`approval.request` **无** `DELEGATED_CALLER` 闸，只有
> `userQuestions.ask` **有**（见 §四.3 / §四.2）。「审批」能不能放子 agent，取决于走哪条 seam，结论见
> [`architecture-framework.md`](architecture-framework.md) §7。

## 五、落地决策（分层，非二选一）

| 场景 | 做成 | 理由（引用） |
| --- | --- | --- |
| 读页面 / 填表单 / 点按钮 这类**短交互** | **主 agent 工具**（DOM 快照优先，可 MCP 或自写） | token 便宜、可即时决策、能 `userQuestions.ask` 问人、能接 approval（§四） |
| **长程研究 / 多页爬取 / 多步复杂流程** | **后台 job 或 subagent**（continuable 推送 或 jobs 轮询） | 隔离脏上下文，只回摘要（§二）；工具无流式 one-shot 兜不住（§四.1） |
| **截图/视觉** 重任务 | 优先拆子任务 | 每步 image token 贵，最易 context rot（§一、taxonomy 轴一） |
| **需人审批 / 登录 / 2FA** | **主 agent 工具 + 审批原语** | 子 agent 内问不了人（§四.2） |
| 未来**远程/本机 computer use** | 工具 = 原语集；子任务 = 长程会话 | 与浏览器同理：控制面（taxonomy 轴二）只改「接谁」，决策框架不变 |

**建议起步路线**（沿用本仓库 `cross-agent-collaboration` 的经验，别重造）：先用 DSH 自带 MCP client
挂 Playwright MCP / 或自写「DOM 快照优先」的浏览器工具验证短交互闭环；再把长程流程接到
`ctx.jobs`（轮询）或 `ctx.subagents` continuable（推送）；敏感动作接 `approval`/`tools/pre-execute`，
需要问人留在主 agent。