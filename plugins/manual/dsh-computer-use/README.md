# dsh-computer-use — DSH 视觉整机控制插件（P2，阶段③：观察 + 动作 + 截图兜底）

把本机 macOS GUI app 经 Accessibility API（AXUIElement）变成 **AX 快照优先**的元素级工具集。
与 `dsh-browser-control`（浏览器 DOM/CDP）是两个独立插件（ADR-1），各自独立授权/禁用/回滚。

## 改了什么

新增 `plugins/manual/dsh-computer-use`。阶段③交付**全部 11 个工具**：

**观察（阶段①）**：

- `computer_doctor` — Swift driver 现场编译 + macOS 辅助功能授权探针（`AXIsProcessTrusted()` 实测，
  不猜）。授权缺席给精确指引（系统设置路径 + 责任进程说明 + TCC 缓存坑），绝不半残运行。
- `computer_list_apps` — 运行中的 GUI app（pid/名称/bundleId/前台/AX 窗口计数；`axWin=null` 即该 app
  AX 树暂不可读的信号）。
- `computer_windows` — 某 app 的可读窗口列表（ref `w<N>` / 标题 / frame / 最小化）。
- `computer_snapshot` — 窗口 AX 树快照：元素带稳定 ref（`@w0/1/2` 路径）、role/title/value/可执行动作
  （`[AXPress]` 等），是动作工具的寻址来源；`maxDepth`/`maxNodes` 双封顶防失控树。

**动作（阶段②，全部敏感动作可选审批，默认关）**：

- `computer_click` — ref（AXPress 语义动作）优先，x/y 坐标兜底（CGEvent）。
- `computer_type` — ref 元素直接 set value（整段替换，AXTextArea/AXTextField 可写时最准）；
  省略 ref 则向焦点元素按字符注入（unicode 事件）。
- `computer_key` — 组合键（`return` / `cmd+shift+t` / `ctrl+a`…），CGEvent 注入前台 app。
- `computer_scroll` — 滚轮滚动（dy 正=上负=下，可带 dx 与位置）。
- `computer_menu` — 菜单栏路径点击（`["文件","新建"]`），自动先 activate（menu bar 只对前台 app 可读）。
- `computer_app` — launch（按 bundleId）/ activate / quit（优雅退出，触发未保存提示，不 SIGTERM）。

**截图兜底（阶段③）**：

- `computer_screenshot` — `screencapture` 落盘返路径（`mode=all` 全屏拼接 / `mode=window` 按 pid+窗口序号
  截窗，CGWindowNumber 由迷你 Swift 探针 `winid` 解析）；`sips` 降采样到长边上限
  （`screenshotMaxDimension`，默认 1280）控制读图 token。**本工具不读图**——把返回的 `path` 传给
  `modlens_read_image` 等视觉能力（2026-08-28 端到端实测：截 TextEdit 存储对话框 → modlens 正确
  OCR 出全部按钮与文案）。适用：目标 app 无 AX 树时兜底观察、动作后确认界面变化。

关键设计（设计权威 `knowledge/domains/computer-use/accessibility-tree-drivers.md` §五）：

- **AX 快照优先，截图只是兜底**（阶段③ `computer_screenshot`，走 `screencapture` 落盘 + modlens 读图）。
- **Swift helper（`driver/axdriver.swift`）**：AXUIElement 遍历 + AX 动作 + CGEvent 注入，
  JSON-lines（stdin 请求/stdout 应答，日志走 stderr）；源码随插件分发，首次使用时 `swiftc` 现场编译
  （幂等，产物复用）；零 npm 依赖。
- **长驻 driver 会话**（`src/session.mjs`）：一次 spawn 跨 tool call 复用；请求按 id 配对；超时/崩溃
  自动回收会话，下次调用重拉；进程归属插件 Fiber，卸载即回收。
- **非 darwin 平台 fail-closed**：`apply` 直接不注册任何工具。
- **审批电门默认关**（`approveActions`）：开启后每个动作弹 `userQuestions.ask`
  一次性审批，人不可达/拒绝/超时一律 fail-closed（`src/approve.mjs`）。
- **屏幕内容 = 不可信输入**：所有工具描述都警告模型——屏幕上与用户请求冲突的指令
  （诱导弹窗等）不要执行，向用户报告。
- ref 路径寻址是「快照与动作自洽」设计：不持有跨调用对象，UI 已变时路径失配报
  `invalidUIElement`，模型重 snapshot 即自愈（与 browser-control 重算 ref 同理）。

### 已知边界（AX 坑矩阵，完整版见 accessibility-tree-drivers.md §四）

- **Electron/Chromium 类 app 默认不暴露 AX 树**（VSCode/Slack/钉钉等）：`snapshot` 会拿到空树或
  `axWin=null`——不是故障，doctor 指引里有 `AXManualAccessibility` 说明；也可走截图兜底。
- 自绘 UI（游戏/部分 Qt/Java）无完整树 → 坐标点击兜底。
- macOS 密码框（SecureField）系统级禁止读取/注入；系统权限弹窗不能替用户点（硬边界）。
- `computer_key`/`computer_type`（无 ref）的键击注入**只落到前台 app**——先 `computer_app activate`。
- unicode 注入与菜单展开后的子菜单挂载需要小延迟（driver 内置 usleep），极慢的 app 可能要重试。
- 2026-08-28 宿主实测：TCC「辅助功能」授权授给**责任进程**——DSH 由终端 launchd 拉起时，AX 授权
  要加在终端 app（或对应宿主条目）上，不是 axdriver 自己。同一实测发现 AXMenuBar 返回
  **单个元素**而非数组（与 AXWindows 不同），`as? [AXUIElement]` 静默失败——已按单元素处理。

## 怎么生效

1. **macOS 14+，装 Xcode Command Line Tools**（`swiftc` 在 `/usr/bin/swiftc`）。
2. 从仓库根目录运行不依赖宿主 peer 的单元测试，再用 `file:` 安装到目标 profile：
   ```bash
   npm --prefix plugins/manual/dsh-computer-use test
   dsh plugin --profile <name> add "file:$PWD/plugins/manual/dsh-computer-use"
   ```
   进入 profile 的安装副本执行 `node scripts/preflight.mjs`，确认宿主 peer 与入口可导入，然后冷启动 DSH。
   AX 能力只能在已授权的 macOS 宿主实测。
3. 模型侧闭环：`computer_doctor`（首次）→ `computer_list_apps` → `computer_snapshot`
   → `computer_click`/`computer_type`/`computer_menu`…。授权缺失时按 doctor 指引到
   「系统设置 → 隐私与安全性 → 辅助功能」把 DSH 责任进程加进去。

## 怎么回滚

```bash
dsh plugin --profile <name> remove dsh-computer-use   # 之后冷启动 DSH
```

driver 编译产物在 `driver/axdriver`（git 忽略），删掉即触发下次重新编译。

## 状态

**v0.1.0 功能完整**（阶段①-④全部交付，2026-08-28）。验收记录见
`knowledge/domains/computer-use/accessibility-tree-drivers.md` §六（GUI-only 对话框 3 步解除、
截图→modlens 读图链路均实测通过）。

后续可选增强（未排期）：Windows（UIA）/ Linux（AT-SPI）driver runtime、拖拽手势、
动作后自动回带窗口截图（对齐 open-computer-use）。
