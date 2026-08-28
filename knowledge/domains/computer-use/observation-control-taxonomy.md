# observation-control-taxonomy — 「观察 / 控制」两轴的分类法（本领域地基）

> 一句话：所有「让 agent 操作浏览器/电脑」的方案，都能落到**两个正交轴**上——①观察什么
> （结构化 DOM/可访问性树 vs 屏幕截图）；②控制谁（本机已登录会话 vs 托管/无头沙箱）。这两轴决定了
> token 成本、能否复用登录态、以及对人审批的需求，是被后面三篇反复引用的公共地基。
> 分级信源规则见本目录 [`README.md`](README.md)。

## 轴一：观察模态（observation modality）——这决定每步花多少 token

agent 每走一步都要「看」一眼界面，看的方式分两类，各有代价：

- **结构化快照（DOM / accessibility tree / a11y snapshot）**：把页面读成结构化文本，
  而不是图片。【L0】OpenCLI 的 README 原文写「Read page content via structured DOM snapshots
  (not screenshots)」，来源：<https://github.com/jackwener/OpenCLI>。【L0】微软 Playwright MCP 的
  默认 `browser_snapshot` 就是 accessibility tree，另有可选的 `browser_take_screenshot`+「vision mode」，
  来源：<https://github.com/microsoft/playwright-mcp> 与 <https://playwright.dev/mcp/vision-mode>。
- **屏幕截图（screenshot / vision）**：把屏幕当图片喂给多模态模型，模型从像素里做定位（grounding）。
  【L1】这是 Claude Computer Use 与 OpenAI CUA 一路的做法，见综述
  Hu et al., "The Dawn of GUI Agent: A Preliminary Case Study with Claude 3.5 Computer Use"
  (arXiv:2411.10323) 与 Zhang et al., "Large Language Model-Brained GUI Agents: A Survey"
  (arXiv:2411.18279)。

**代价结论**（这里是被引用的事实，别处直接链到这里）：

- 文本 a11y 快照便宜且确定；截图的图像 token 每一步都贵，且长任务里会快速积水。
  【L2】社区实测：`echo-lumen/cdp-browser-mcp` 用 CDP 直接读快照，README 自称「5.5x fewer tokens
  than Playwright MCP」，来源：<https://github.com/echo-lumen/cdp-browser-mcp>（该倍数为社区自报，
  未独立复测，故归 L2 而非 L0）。【L2】《Where the Snapshot Lives Changes Everything Else》论证
  「快照落在哪一层」决定整个 agent 设计，来源：
  <https://current.tinyfish.ai/issue/latest/foundations/article/24492/where-the-snapshot-lives-changes-everything-else>。
- 截图的问题不是「不能看」，而是**可测性、确定性、定位精度**：像素级定位（point-of-motion 点击 x,y）
  对同一元素在不同分辨率/滚动位置下会漂移；a11y 树给的是稳定语义引用（role/name/id）。
  【L1】该取舍是 GUI-agent 综述的公共结论，见 arXiv:2411.18279 中「observation」与「grounding」章节。

## 轴二：控制面（control surface）——这决定「用在谁的会话/设备」上

- **本机已登录会话（local, attached）**：把 agent 接进用户**已经打开的、已登录的**浏览器/桌面。
  好处是**登录态天然可复用**（不需要 agent 自己过登录/CAPTCHA）。【L0】OpenCLI 是纯这条路的代表：
  Browser Bridge 扩展 + 本地 daemon 挂到 Chrome，见 <https://github.com/jackwener/OpenCLI>。
  【L2，2026-08 本机实测】Chrome ≥136 拒绝在**默认** user-data-dir 上开 `--remote-debugging-port`
  （报 "DevTools remote debugging requires a non-default data directory"）。→ 裸 CDP 端口无法直接
  attach 到用户日常登录的默认 profile；要么用独立 `--user-data-dir`（登录态需在该独立 profile 里重新
  登录一次、之后常驻复用），要么走 OpenCLI 式「扩展 + local daemon」绕过（这也是 OpenCLI 不用裸端口的
  原因之一）。本仓库 `dsh-browser-control`（P0）当前走「独立 profile + `--remote-debugging-port`」。
  【L0】Codex 桌面版 Computer Use 也走这条路，官方写「If ChatGPT uses your browser, it can interact
  with pages where you're already signed in.」，来源：<https://developers.openai.com/codex/computer-use>。
- **托管/无头沙箱（remote / headless sandbox）**：agent 在自己的环境里拉起一个干净浏览器（无你的登录
  态、无历史），每步截图/快照再控制。好处是隔离与可复现，坏处是登录态、2FA、风控要额外处理。
  【L1】Codex 云端形态属于这条（Codex 运行在 OpenAI 托管环境，并有内置 Browser 能力；官方文档导航含
  「Environments › Modes › Local environments / Cloud environment」），来源：
  <https://developers.openai.com/codex/>（导航结构）与 <https://openai.com/index/computer-using-agent/>。
- **混合**：多数成熟方案两条都留了口子，例如 OpenCLI 也支持 `OPENCLI_CDP_ENDPOINT` 指向远端 CDP，
  【L0】见 README；Playwright MCP 既可本机 Chrome 也可 connect 到远端。

## 为什么这两轴是「地基」

后面三篇的所有结论都在这两轴上：

- [`opencli-vs-codex.md`](opencli-vs-codex.md) —— OpenCLI 与 Codex 的本质差异 = 轴一（DOM vs 截图）
  和轴二（本机 attach vs 托管沙箱）的组合差异。
- [`community-landscape.md`](community-landscape.md) —— 社区方案的分类就是用这两轴 + 「接口形态」。
- [`tool-vs-subagent.md`](tool-vs-subagent.md) —— 「做成工具还是拆子任务」的核心变量之一，就是
  轴一带来的 token 成本差异（截图贵 → 放工具里会快速胀上下文 → 更该拆子任务）。