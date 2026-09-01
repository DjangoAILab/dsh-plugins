# dsh-browser-control — DSH 浏览器控制插件（P0）

把「本机已登录 Chrome」经 CDP（Chrome DevTools Protocol）变成 DOM 快照优先的短交互工具集。

## 改了什么

新增 `plugins/manual/dsh-browser-control`，一个对标 Codex browser bridge / Playwright MCP 的
**DOM 快照优先**浏览器工具集（29 个工具）：

- **导航**：`browser_pages` / `browser_navigate` / `browser_navigate_back` / `browser_navigate_forward` / `browser_reload`
- **Tab 管理**：`browser_new_page` / `browser_close_page` / `browser_select_page`
- **观察**：`browser_snapshot`（a11y 树 + 稳定 `ref=@N`）/ `browser_extract` / `browser_screenshot`（P0.5 兜底：只截屏落盘返回路径）/ `browser_console_messages` / `browser_network_requests`
- **元素操作**：`browser_click` / `browser_type` / `browser_fill` / `browser_select_option` / `browser_hover` / `browser_scroll` / `browser_press_key` / `browser_drag`
- **会话/对话框/文件**：`browser_launch`（自启 Chrome）/ `browser_wait_for` / `browser_evaluate` / `browser_handle_dialog` / `browser_file_upload` / `browser_cookies`（值打码）/ `browser_delete_cookies` / `browser_storage`

关键设计：

- **观察模态走结构化 a11y 快照优先**（token 便宜、确定性高），不是截图（理由见
  `knowledge/domains/computer-use/observation-control-taxonomy.md`）；所有「取元素」都用 ref 命中。
- **快照 ref 只标注可交互角色**（button/link/textbox/checkbox/slider/tab/…，白名单见
  `src/snapshot.mjs` 的 `INTERACTIVE_ROLES`）；StaticText/heading/image 等静态内容只渲染行不占 ref，
  ref 序号更少更稳。`dialog`/`alertdialog`/`tooltip` 等容器角色不分配 ref，其内部可交互子元素
  （button 等）正常有 ref；纯容器本身需要操作时用 `browser_evaluate`。快照只覆盖顶层 frame；
  iframe 内容（含同源）不在快照中，必要时用 `browser_evaluate` 检查 iframe 内部。
- **输出有截断预算**：snapshot 截到 60000 字符、extract 20000、evaluate 20000
  （`src/truncate.mjs` 统一原语），超长追加 `…[truncated N of M chars]`；console/network 另有
  200 条环形缓冲上限。
- **点击/输入走视口坐标系**：目标元素先 `scrollIntoView` 进视口，再用
  `getBoundingClientRect` 取中心并校验在视口内（不再用文档坐标系的 `DOM.getBoxModel`，
  杜绝「滚动后点击静默落空」）。
- **navigate 双重校验**：URL scheme 白名单只放行 http(s)/about/data（**file:// 已禁用**）；
  读取 `Page.navigate` 返回的 `errorText`，导航失败如实报错，成功后回显页面实际
  `location.href`。back/forward/reload 走 CDP 历史导航（`Page.getNavigationHistory` +
  `Page.navigateToHistoryEntry`），返回导航后的 URL。
- **持久连接池**（`src/session.mjs`，按 targetId；并发 acquire 用 in-flight promise 去重）：
  一次连接跨 tool call 复用，解锁对话框处理 + console/network 事件累积观测 + 消除重连握手
  开销；navigate/reload/历史导航会重置该 target 的观测缓冲；close_page / 插件卸载时回收。
- **自动拉浏览器**（`src/launcher.mjs`）：`autoLaunch` 默认开——任一浏览器工具（含
  `browser_pages`）发现 CDP 端点不在，就 `spawn(detached)` 拉起带 `--remote-debugging-port`
  的 Chrome（独立 profile，DSH 重启不杀浏览器、登录态常驻）；也可显式调 `browser_launch`。
- 敏感动作（click/type/fill/select_option/press_key/drag/evaluate/file_upload/
  delete_cookies）可选人工审批：`approveActions: true` 时走 `userQuestions.ask`
  （复用 `ops-ssh-manager` 模式，fail-closed）。审批 detail 带动作上下文（evaluate 的
  表达式截断、drag 的起止目标、file_upload 的完整路径列表、delete_cookies 的 name/url）。
  默认 `false` 的理由：P0 是短交互闭环，审批电门在 P1（见 `architecture-framework.md` §5）。
- **零 npm 运行时依赖**：CDP 用 Node 22 全局 WebSocket + fetch；登录态天然复用（连的是已登录 Chrome）。

设计权威见 `knowledge/domains/computer-use/architecture-framework.md`；审批机制见
`knowledge/foundations/tool-approval-interception-and-secrets.md`。

**产品决策记录：`browser_storage` get 保留明文返回**（操作员已确认，不追加审批）。理由：
get/set/remove 是对称的低敏读写面，追加审批会打断正常调试流；风险是 localStorage 可能含
敏感 token。缓解：值只进当前会话上下文——插件自身不落盘、不打日志；工具 description 明确
告诫「勿将读到的值写入日志或回显给不可信方」。`browser_cookies` 的值仍然一律打码。

## 怎么生效

1. **无需手动开 Chrome**：`autoLaunch` 默认开，用任一浏览器工具会自动拉起带调试端口的 Chrome
   （独立 profile `~/dsh-browser-profile`，非默认 `--user-data-dir` 是 Chrome ≥136 的强制要求）。
   第一次用它时在弹出的窗口里登录一次账号，之后登录态常驻、重启即复用。想手动开也可：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 --user-data-dir="$HOME/dsh-browser-profile"
   ```
2. 隔离验证统一走 dsh-lab（强约束，见 AGENTS.md §八）：
   ```bash
   knowledge/runbooks/dsh-plugin-development/dsh-lab install dsh-browser-control
   knowledge/runbooks/dsh-plugin-development/dsh-lab verify dsh-browser-control
   ```
3. 模型侧直接用 `browser_navigate` → `browser_snapshot` → `browser_click`/`browser_type` 闭环；
   开启 `approveActions: true` 后敏感动作会弹一次性审批。

## 怎么回滚

```bash
# 移除 plugin 行并重启 DSH 即还原（bundle 插件）：
dsh plugin remove dsh-browser-control   # 之后重启 DSH
```

dsh-lab 验证阶段：`dsh-lab reset --yes` 丢弃 Lab 状态即可，本机 profile 不受影响。

## 待办（承自 roadmap）

- P0 只做「attach 本机已登录 Chrome」；「无头沙箱」由后续 provider 分支补齐。
- `browser_screenshot` 只「截屏落盘 + 返回路径」，读图交给 `modlens_read_image` 等视觉能力（纯文本模型读不了像素，故不接附件管道）。
- HTML5 原生 drag-start/drop 未覆盖（`browser_drag` 是鼠标轨迹拖拽，覆盖滑块/自定义拖拽 UI）。
- 刻意**不含** `execute_cdp` 逃生舱（任意 CDP ≈ 绕过审批与 DOM 抽象，违反 fail-closed）。