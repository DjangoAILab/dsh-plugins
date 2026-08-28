# community-landscape — 社区「操作浏览器 / computer use」方案全景（问题二）

> 一句话：社区已经**大量涌现**，且按 [`observation-control-taxonomy.md`](observation-control-taxonomy.md)
> 的两轴基本能归类完；但「开箱即用、且贴合 DSH 原语」的**没有现成的**——要么是通用 MCP/库要自己接，
> 要么是绑在特定 agent 上的技能。star 数均为 2026-08 实测。分级信源规则见 [`README.md`](README.md)。

## 一、先按「接口形态 × 两轴」切一刀

| 接口形态 | 观察模态 | 代表 | 面向谁 |
| --- | --- | --- | --- |
| MCP server（通用，任何 agent 可挂） | DOM/a11y 快照 + 可选截图 | Playwright MCP、Chrome DevTools MCP、open-computer-use | 跨 agent |
| Python/TS 库（自己 orchestrate） | DOM + 截图混合 | browser-use、Skyvern、Stagehand | 应用开发者 |
| CLI + 站点适配器（确定性命令） | DOM 快照 | OpenCLI | CLI 用户 + agent skill |
| 个人助理（整机+浏览器） | 截图/DOM 混合 | OpenClaw | 端用户 |
| 框架/模型（重构模型而非接模型） | 截图为主 | OpenCUA | 研究者/自建 |

## 二、逐项（含证据 + 等级）

### 1. MCP 通用出口类

- **Playwright MCP**（microsoft，36.3k★）【L0】<https://github.com/microsoft/playwright-mcp>：
  a11y 快照为默认观察，另有截图与 vision mode【L2】<https://playwright.dev/mcp/vision-mode>。
  是「把浏览器当通用 MCP 工具」的事实标准，DSH 可经自带 MCP client 直接挂。
- **Chrome DevTools MCP**（Chrome 官方，49.4k★）【L0】<https://github.com/ChromeDevTools/chrome-devtools-mcp>：
  走 CDP，与 Playwright MCP 同源谱系。
- **open-computer-use**【L0】<https://github.com/iFurySt/open-codex-computer-use>：
  把 CUA 建在 Accessibility 上、包装成 MCP，能给 Codex/Claude/Gemini 复用，是「本机 computer use 的
  开源可读实现」。【L0，2026-08-28 更新】已被 QwenLM 官方接手 fork 为
  <https://github.com/QwenLM/open-computer-use>（npm `@qwen-code/open-computer-use`），扩展为
  macOS/Windows/Linux 三平台，是当前 Accessibility 优先路线的成熟代表；细节见
  [`accessibility-tree-drivers.md`](accessibility-tree-drivers.md)。
- **OpenCUA**（xlang-ai）【L0】<https://github.com/xlang-ai/OpenCUA>：NeurIPS 2025 Spotlight，
  开源 computer-use agent 的**基础框架 + 数据集 + 模型**，学术路线代表。

### 2. 应用开发库 / SDK 类

- **browser-use**（109.7k★）【L0】<https://github.com/browser-use/browser-use>：Python，
  "Make websites accessible for AI agents"，DOM+视觉混合的编排库，社区最大。
- **Stagehand**（Browserbase，24k★）【L0】<https://github.com/browserbase/stagehand>：
  TS SDK，"The SDK For Browser Agents"，偏对开发者的可编程可控。
- **Skyvern**（22.8k★）【L0】<https://github.com/Skyvern-AI/skyvern>：LLM + CV 驱动的工作流式
  agent，偏「表单/流程」自动化。

### 3. CLI + 站点适配器类

- **OpenCLI**（28.3k★）【L0】<https://github.com/jackwener/OpenCLI>：见
  [`opencli-vs-codex.md`](opencli-vs-codex.md)，「已登录浏览器 → 确定性 CLI」，agent 侧走 skill。
  【L2】社区解读 <https://zhuanlan.zhihu.com/p/2062925166116594654>。

### 4. 个人助理 / 整机类

- **OpenClaw**（openclaw）【L0】<https://github.com/openclaw/openclaw>：个人 AI 助理，浏览器(CDP) +
  整机控制，技能生态大；浏览器控制的关键机制见其官方文档 <https://docs.openclaw.ai/tools/browser>。

### 5. 反检测 / 专用

- **Camoufox**【L2】：anti-detect 浏览器（绕 bot/CAPTCHA），本仓库已有集成配方
  （`plugins/community/` 与相关 skill）。

## 三、对 DSH 的关系评估（缺口）

【L1，见 L0 工具契约 `../../foundations/tool-async-and-callback-contract.md` 的结论】

- **能马上复用的**：MCP 系（Playwright MCP / Chrome DevTools MCP）——DSH 自带 MCP client，
  「把浏览器当工具」这条链基本是现成拼接，不需要重造浏览器驱动。
- **能被「吸收」的**：OpenCLI 的「DOM 快照 + 确定性适配器」思路，可以变成「DSH 原生浏览器工具」的
  设计参考（省 token、确定性、可回归），而不必把整个 28k★ CLI 缚进来。
- **缺的那层（要自己补）**：没有一个现成方案**原生映射 DSH 的审批/异步原语**——社区方案要么同步
  one-shot，要么自带它的审批体系，都不懂 DSH 的 `approval`/`guard`/`userQuestions`。所以做 DSH 的
  浏览器能力时，「浏览器驱动」可抄社区，「审批/异步/人机边界」要自己接到 DSH 原语（见
  [`tool-vs-subagent.md`](tool-vs-subagent.md)。
- **反检测**是额外维度：Camoufox/opencli 这些人肉登录态路线，本身就在缓解反检测；把它并进「观察/控制」
  两轴之外的**第三维「规避维度」**更清楚（本目录暂列为专用类，未展开）。
