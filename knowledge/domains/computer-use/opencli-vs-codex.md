# opencli-vs-codex — OpenCLI 与 Codex Computer Use 的异同（问题一）

> 一句话：OpenCLI 和 Codex 的 computer use 是「同一目标（让 agent 操作 GUI）、两套相反的工程取向」。
> OpenCLI = **本机已登录浏览器 + 结构化 DOM 快照 + 确定性站点适配器**；Codex = **通用视觉 GUI agent
> （截图 → 点坐标）**，既有「托管云端」也有「本机桌面」两条面。差异可以完全归结到
> [`observation-control-taxonomy.md`](observation-control-taxonomy.md) 的观察轴 × 控制轴。
> 分级信源规则见 [`README.md`](README.md)。

## 一、先校正一个名称事实

你记忆里的「OpenCOI」= **OpenCLI**（`jackwener/OpenCLI`），不是 OpenCUA/OpenClaw/其他。
【L0】仓库描述原文 "Convert any website into a CLI & run Browser Use on your logged-in Chrome."，
约 28.3k stars（2026-08 实测），来源：<https://github.com/jackwener/OpenCLI>。

## 二、OpenCLI 具体怎么做（机制）

【L0，全部来自 README 原文，见 <https://github.com/jackwener/OpenCLI>】

1. **连接方式**：Chrome/Chromium 通过 **Browser Bridge 浏览器扩展 + 一个小本地 daemon** 接入；
   daemon 需要时自动拉起。扩展按 Chrome profile 隔离，可给 profile 起别名。
2. **观察**：`opencli browser` 读**结构化 DOM 快照**（README 原文明写 "structured DOM snapshots
   (**not screenshots**)")，可 `get`/`find`/`extract` 内容、**拦截网络 API 响应**。
3. **控制**：`navigate` / `click` / `type` / `fill` / `select` / `keys` / `scroll` / `eval` /
   `network` 等一组 CLI 原语；每个 `browser <session> ...` 子命令以 tab 目标 + 会话租约为单位。
4. **确定性适配器**：100+ 站点（B站/小红书/知乎/X/Reddit…）被固化成 `opencli <site> <command>`
   确定性命令；桌面 Electron app（Cursor/Codex/ChatGPT…）也经 CDP 复用同一条链。
5. **给 agent 的出口**：`npx skills add jackwener/opencli` 把 `opencli-browser` 等技能装进
   Claude Code / Cursor 等 agent，agent 内部直接调 CLI 原语。
6. **可选远端**：`OPENCLI_CDP_ENDPOINT` 可指向远端 CDP（远程浏览器或 Electron），默认仍是本机。

**一句话**：OpenCLI 把「已登录浏览器」变成一个**可被 agent 确定性驱动的本地 CLI 集**，登录态零迁移。

## 三、Codex Computer Use 具体怎么做（机制）

Codex 有**两条 computer use 面**，别混：

### 3.1 本机桌面面（macOS / Windows）

【L0，来自官方文档 <https://developers.openai.com/codex/computer-use>，引用均为原文】

- **权限模型**：macOS 要授予「屏幕录制 Screen Recording（让 agent 看见）+ 辅助功能 Accessibility
  （让 agent 点击/输入/导航）」；Windows 在**前台桌面**操作（会接管鼠标键盘）。
- **观察 = 屏幕**，不是 DOM：它的定位是「对命令行/结构化集成不够的任务」用 GUI（如操作一个
  桌面 app、复现只在 GUI 出现的 bug）。
- **能复用登录态**：官方原文 "If ChatGPT uses your browser, it can interact with pages where
  you're already signed in."（走 Chrome 扩展附加控制）。
- **有人审批**：app 级 approval（用哪个 app 要你允许，可 Always allow）+ 敏感操作再问你；系统权限
  弹窗它不能替你点（不能以 admin 认证、不能 approve 系统权限弹窗）。
- **局限**：不能自动化终端或 ChatGPT 自身（防绕过安全策略）。

### 3.2 托管云端面（Codex cloud / CLI）

【L1】Codex 运行在 OpenAI 托管环境，官方文档导航有「Environments › Modes › Local environments /
Cloud environment」并列出内置 **Browser** 能力（来源 <https://developers.openai.com/codex/>）；
这就是你说的「像远程控制」的那一面——浏览器跑在 OpenAI 那边，agent 看截图、发点击。本机桌面版文档另提
「use remote control from your phone」以在后台任务时远观进度（来源
<https://developers.openai.com/codex/computer-use>）。

### 3.3 底层模型：CUA（Computer-Using Agent）

【L1】OpenAI 把 CUA 描述为「看截图 + 用户意图 + 历史动作 → 输出下一个动作（在 x,y 点击/滚动/输入）」
的视觉 agent，来源：<https://openai.com/index/computer-using-agent/>；其「像素级定位（point-of-motion）」
与「先 summary 后 action」的范式见综述 arXiv:2411.18279。【L0】开源复刻 `open-computer-use`
（iFurySt）证明这套 CUA 可以「建在 Accessibility 上、非侵入」，README 明写 "non-intrusive CUA can be
built on top of Accessibility, inspired by OpenAI Codex Computer Use"，来源：
<https://github.com/iFurySt/open-codex-computer-use>。

## 四、异同对比（把三→二映射到两轴）

| 维度 | OpenCLI（`jackwener/opencli`） | Codex Computer Use |
| --- | --- | --- |
| **观察模态（轴一）** | 结构化 DOM 快照（**非截图**）【L0】 | 屏幕截图 / 像素定位【L0/L1】 |
| **控制面（轴二）** | 本机已登录浏览器 attach（可选 CDP 远端）【L0】 | 两条：托管云端沙箱（远程）+ 本机桌面 app【L1】 |
| **登录态** | 直接复用（零迁移）【L0】 | 桌面版可复用（"already signed in"）【L0】；云端默认全新会话 |
| **接口形态** | 确定性 CLI + 100+ 站点适配器 + agent skill【L0】 | 通用视觉 agent + desktop app/MCP/server/skill【L0】 |
| **可测性/确定性** | 高（命令级、可回归）【L0】 | 中（视觉定位有漂移，靠 POM/复查）【L1】 |
| **token 成本** | 低（文本快照）【L1 推断，参见 taxonomy】 | 高（每步截图）【L1】 |
| **审批/安全** | 依赖宿主 agent 的审批（DSH 有原生 approval/guard） | 自带 app approval + 权限弹窗不可自动批准【L0】 |

**核心结论**：

1. **相同点**：都是「把 GUI 变成 agent 的输出/输入空间」，都要处理「观察 → 定位 → 动作 → 重观察」闭环。
2. **本质差异不在「本地 vs 远程」这个表象**，而在**观察模态**：OpenCLI 读结构、Codex 看像素。远程/本地
   （控制面）是第二位的差异，且 Codex 自己两条都有——所以「Codex = 远程控制」这个印象**只对了一半**
   （它的云端面是远程，但它也有本机桌面面）。
3. 对你目标的启发：**「复用登录态 + 确定性 + 省 token」= OpenCLI 路线**；**「通用、啥界面都能啃、
   代价是截图贵 + 定位漂移 + 要审批」= Codex 路线**。给 DSH 做能力时，两者不是非此即彼，可以
   「DOM 为主、截图兜底」。