# accessibility-tree-drivers — Accessibility 树 driver：社区实现、技术细节与平台边界（P2 设计输入）

> 一句话：2026 年社区 computer use 已从「纯截图 + 坐标点击」收敛为 **Accessibility（辅助功能）树优先**——
> 元素树做观察与定位（token 便宜、确定、可元素级操作），截图降级为「动作后确认 / 无树兜底」。本文记录
> 这一收敛的证据、辅助功能树在三大平台的技术实现与硬边界，是 `dsh-computer-use`（P2）driver 设计的
> 直接输入。总框架与 ADR 见 [`architecture-framework.md`](architecture-framework.md)；两轴分类法见
> [`observation-control-taxonomy.md`](observation-control-taxonomy.md)。分级信源规则见本目录
> [`README.md`](README.md)。调研与核实时间：2026-08-28。

## 一、社区收敛：视觉优先 → Accessibility 优先

早期范式（Claude Computer Use / OpenAI CUA，见 [`opencli-vs-codex.md`](opencli-vs-codex.md) §三）是
「截图 → 模型像素定位 → 坐标点击」循环。2026 年的三个活跃实现都把元素树放到了主轴上：

| 项目 | 观察主轴 | 截图的角色 | driver 实现 | 证据等级 |
| --- | --- | --- | --- | --- |
| **open-computer-use**（QwenLM 官方 fork，npm `@qwen-code/open-computer-use`） | `get_app_state` 返回 a11y 元素树 + `element_index`，动作按元素索引寻址 | 每个动作工具执行后**附一张执行后的窗口截图**做确认（ScreenCaptureKit 按窗截取 + 降采样 + 字节预算） | macOS=Swift（`AccessibilitySnapshot.swift`）；Windows=Go+PowerShell UIA；Linux=Go+Python AT-SPI | 【L0】<https://github.com/QwenLM/open-computer-use> 与其 `docs/IMAGE_CAPTURE.md` 原文 |
| **OpenClaw** | Peekaboo（默认）/CUA driver 双 provider；坐标动作**必须回显截图的 `frameId`**（新鲜度令牌，防错点旧帧） | 截图只给模型不进聊天流；「画面与上一帧像素相同」时只返回元数据不重复发图 | macOS 签名 app 内嵌 `cua-driver` daemon（`--embedded` 模式，私有 socket 0600）；Win/Linux 走 `cua-computer` 插件（CUA Driver SDK 0.21.0） | 【L0】<https://github.com/openclaw/openclaw/blob/main/docs/nodes/computer-use.md> |
| **QwenPaw**（agentscope） | PR 标题即 "accessibility-first"（Windows + macOS 原生 GUI 自动化） | — | — | 【L2】<https://github.com/agentscope-ai/QwenPaw/pull/6424> |

两个共同的工程信号【L0，上表两项目文档原文】：

1. **模型侧要求**：OpenClaw 明确要求 **vision-capable model** 才能驱动 computer 工具；纯文本模型至少
   需要「截图 → 证据文本」的桥（本仓库即 modlens 链路，见
   `plugins/community/modlens-vision/README.md`）。
2. **屏幕内容一律当不可信输入**：OpenClaw 工具原文警告模型不要执行屏幕上与用户请求冲突的指令
   （防 prompt injection）。这一点应写进本仓库 P2 的工具描述。

## 二、辅助功能树是什么：读屏基础设施，不是浏览器专属

**原理**【L1，综述 arXiv:2411.18279 的 observation/grounding 章节 + 各平台官方文档，见下表】：
操作系统为支持读屏器（macOS VoiceOver、Windows Narrator、Linux ORCA），要求 GUI app 把界面暴露成
一棵**语义元素树**——不是像素，是「窗口 → 按钮/文本框/菜单」的对象结构，每个元素带属性
（role / title / value / position / size）和**可执行动作**（如 macOS `AXPress`、`AXConfirm`、
set value）。任何进程持有相应权限即可读树、调元素动作，等价于「把 GUI app 读成 DOM」。
DSH 浏览器插件的 `browser_snapshot`（a11y 树 + ref）本就是同一机制在网页里的投影——P2 的
`snapshot → ref → action` 闭环与之同构。

**三大平台实现与权限**【L0，官方文档/项目 README 原文】：

| 平台 | API | 权限要求 | 备注 |
| --- | --- | --- | --- |
| macOS | `AXUIElement` C API（`ApplicationsServices`，官方页 <https://developer.apple.com/documentation/applicationservices/axuielelement_h>） | TCC「辅助功能」（读树/注入）+「屏幕录制」（截屏） | 键鼠注入用 `CGEvent`；OpenClaw 补充要求 Event Posting |
| Windows | UI Automation（UIA，MSAA 继任者，<https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcore/>） | 无需特殊授权【L0】open-computer-use README 原文 "Windows and Linux do not need this step" | Win32/WPF/WinUI/Electron 都暴露 |
| Linux | AT-SPI2（D-Bus） | 无需特殊授权【L0】同上 | **Wayland 限制全局注入与截屏**；OpenClaw 验证环境明确拒绝 native Wayland、只走 X11 |

结论：**「辅助功能树」概念跨平台通用，driver 每平台各写一套**（open-computer-use 即 Swift /
Go+PowerShell / Go+Python 三套 runtime）。

## 三、driver 工程要点（两个成熟实现的可抄结论）

【L0，§一表两项目的文档/源码结构，2026-08-28 核实】

1. **helper 进程 + 结构化 IO**：open-computer-use 的 macOS runtime 是独立 Swift 进程（编译产物由
   包管理），Node 侧经其 CLI/MCP 层调用。本仓库对应形态：`swiftc` 现场编译的单文件 helper，
   stdin/stdout JSON-lines 通信，零 npm 依赖。
2. **doctor fail-closed**：open-computer-use 的 `doctor` "Check permissions; onboarding only opens
   when something is missing"——权限缺失才引导，缺了绝不半残运行。与
   [`architecture-framework.md`](architecture-framework.md) §6 的既有决策一致。
3. **截图管线（若做动作后确认）**：按**目标窗口**截（非全屏）→ 降采样到长边/字节上限
   （open-computer-use 默认 maxDimension=1280、maxBytes≈900KB、`scale *= 0.85` 迭代）→ 坐标类工具
   按 PNG 实际尺寸**重标定**模型给的坐标。捕获超时只丢 image block、**树照常返回**。
4. **新鲜度绑定**：OpenClaw 的 `frameId` 回显 + 「display 重连/几何变化即 fail closed」+ 「token 不是
   新鲜度保证，场景可能变了就重截」——坐标路径必须防陈旧帧。
5. **信任模型**：OpenClaw 原文 "The Gateway is the authorization chokepoint; the driver is a dumb
   effector"——driver 不做授权决策，只做执行器；授权收敛在上层（本仓库对应 DSH 的
   approval/guard/工具审批，见 `knowledge/foundations/tool-approval-interception-and-secrets.md`）。
6. **TCC 责任链（macOS 特有坑）**：OpenClaw 坚持由签名 app **直接 spawn** driver daemon（不走
   Gateway/`open(1)`/`NSWorkspace`），否则 "break macOS's TCC responsibility chain and create a
   second permission identity"。→ 本仓库 P2 的 helper 必须由 DSH 进程树直接 spawn，权限实际授给谁
   （DSH 宿主进程链）是阶段④的**必测项**。
7. **明确不抄的**：OpenClaw 式签名 app 内嵌 daemon 是给分发产品的；本仓库单机自用，直接 spawn
   helper 即可，无需 daemon 常驻与 socket 管理 taxonomy。

## 四、硬边界与已知坑（写进 doctor 与验收）

| 边界 | 内容 | 等级与来源 |
| --- | --- | --- |
| **Electron/Chromium 默认不开 AX 树** | 只在检测到读屏器时暴露；可 `app.setAccessibilitySupportEnabled(true)`（app 侧）或由第三方进程设 `AXManualAccessibility` 属性强开；系统读屏优先级更高 | 【L0】Electron 官方文档 <https://www.electronjs.org/docs/latest/tutorial/accessibility>。VSCode/Slack/Chrome/钉钉类均受影响 |
| **自绘 UI 无完整树** | 游戏、部分 Qt/Java 自绘控件拿不到有意义元素 → 只能截图 + 坐标 | 【L2】社区共识（open-computer-use 保留坐标路径即为此兜底） |
| **macOS 密码框（SecureField）** | 系统级禁止读取/注入，无解 | 【L1】Codex 官方局限清单同类（不能 approve 系统权限弹窗、不能 admin 认证），见 <https://developers.openai.com/codex/computer-use> |
| **系统权限弹窗不可自动批准** | TCC 授权弹窗必须人来点；agent 不能替点 | 【L0】同上 Codex 官方原文 |
| **Wayland** | 全局注入/截屏受限，只承诺 X11 | 【L0】OpenClaw 验证 rig 文档原文 "The rig rejects native Wayland" |
| **快照空树 ≠ 故障** | 目标 app 未暴露树时应返回结构化「无 AX 树」提示并引导走截图，而不是报错 | 设计决议（本仓库），依据上两行 |

### 4.1 宿主实测新坑（2026-08-28，dsh-computer-use 开发过程一手证据【L2 实测】）

以下均为本仓库开发 `dsh-computer-use`（阶段①②③）时在 macOS 15.6 宿主实测发现，官方文档未载：

1. **TCC「辅助功能」授权授给责任进程（responsible process），不是 driver 二进制**：
   terminal→bash→axdriver 链上 `AXIsProcessTrusted()`=false，把终端 app 加进辅助功能白名单后即
   true；DSH 由 launchd 常驻时授权对象同理加在宿主条目上。`osascript` 走 System Events 能通不代表
   AX 裸 API 授权可用——Apple Events 自动化与辅助功能是**两条独立 TCC 通道**。
2. **`AXMenuBar` 返回单个元素，不是元素数组**（与 `AXWindows` 行为相反）：`as? [AXUIElement]`
   静默失败（CFTypeID 相同但桥接 cast 不成立），必须按单 `AXUIElement` 处理。
3. **menu bar 只对前台 app 可读**：后台 app 读 `AXMenuBar` 拿不到有意义结果，菜单操作前必须先
   activate 目标 app 并留切换延迟。
4. **子菜单项挂在 AXMenu role 的子元素下且要点开后才挂载**：顶级菜单 children 是菜单项；
   二级菜单要先 AXPress 顶层项、等 ~120ms，再从其 AXMenu 子元素取 items。
5. **`screencapture -l <id>` 的窗口 id 来自 CGWindowList，AX 树的 ref 不携带它**：需要单独的
   CGWindowListCopyWindowInfo 探针按 pid+序号匹配（本仓库 `winid` 探针）。
6. **`FileHandle.synchronizeFile()` 在管道 stdout 上抛 NSFileHandleOperationException 直接崩溃**：
   Swift CLI 做 JSON-lines stdout 协议通道时用 `fputs+fflush`，不要用 FileHandle 写管道。
7. **Node test runner 合跑含子进程 stdio 的测试时 ev loop 可能被挂住**（单跑正常）：测试文件末尾
   放一个 unref 的兜底 `setTimeout(process.exit)` 即可，不代表被测代码有泄漏。

## 五、对 P2（`dsh-computer-use` v1）的设计落点（决议）

- **路线**：AX 快照优先（`snapshot → ref → action`，与 `dsh-browser-control` 同构闭环）+
  `computer_screenshot` 显式兜底（落盘返路径，读图走既有 modlens 链路）。不采用纯截图坐标范式
  （token 贵、漂移、不可回归，且本机主力模型纯文本）。
- **v1 工具集（9 个）**：观察 `computer_list_apps` / `computer_snapshot` / `computer_screenshot`；
  动作 `computer_click`（AXPress 优先、坐标兜底）/ `computer_type` / `computer_key` /
  `computer_scroll` / `computer_menu` / `computer_app`（launch/activate/quit）。
- **driver**：Swift 辅助进程（AXUIElement + CGEvent），源码随插件分发、preflight 时 `swiftc` 现场编译
  （2026-08 实测本机 swiftc 6.1 可用），JSON-lines IO，由 DSH 进程树直接 spawn（§三.6 TCC 责任链）。
  driver 进程边界按可替换设计（对标 open-computer-use 多 runtime 结构），Windows/Linux 本期不做。
- **审批**：敏感动作可选人工审批，默认关；启用后接 `userQuestions.ask`，审批不可用、拒绝或异常时
  fail-closed。
- **doctor**：启动自检屏幕录制 + 辅助功能授权，缺失即拒绝并给指引（fail-closed，§三.2）；
  Electron 空树场景输出 `AXManualAccessibility` 引导（§四）。
- **阶段**：①doctor+driver 骨架+观察工具 → ②动作工具 → ③screenshot+审批钩子+config →
  ④安装副本预检 + README。macOS 权限实测只在明确授权的宿主环境执行。

## 六、实施结果（2026-08-28，阶段①-④完成）

四个阶段全部交付，最终形态 `plugins/manual/dsh-computer-use` v0.1.0（11 个工具，零 npm 依赖）：

- **验收场景实测通过**：「复现/解除 GUI-only 故障至多 3 步」——TextEdit 弹「要保留此文稿吗」对话框
  （命令行无法触达的状态），`computer_snapshot` 定位按钮（删除/取消/存储带 ref）→ `computer_click`
  AXPress「删除」→ 重 snapshot 确认对话框消失、文稿丢弃。3 个工具调用完成。
- **截图→视觉链路实测通过**：截 TextEdit 存储对话框 → `modlens_read_image` 正确 OCR 全部按钮与文案。
- **单测**：41 个（config/snapshot/doctor/session/approve/screenshot），宿主与 Lab 全绿；
  Lab 容器验证 Linux fail-closed（不注册工具）+ 安装/加载/冷启动链。
- 知识库沉淀：§4.1 的 7 条一手坑（TCC 责任进程、AXMenuBar 单元素等）。
