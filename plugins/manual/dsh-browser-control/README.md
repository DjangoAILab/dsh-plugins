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
- **持久连接池**（`src/session.mjs`，按 targetId）：一次连接跨 tool call 复用，解锁对话框处理 +
  console/network 事件累积观测 + 消除重连握手开销；close_page / 插件卸载时回收。
- **自动拉浏览器**（`src/launcher.mjs`）：`autoLaunch` 默认开——任一浏览器工具发现 CDP 端点不在，
  就 `spawn(detached)` 拉起带 `--remote-debugging-port` 的 Chrome（独立 profile，DSH 重启不杀浏览器、
  登录态常驻）；也可显式调 `browser_launch`。
- 敏感动作（click/type/fill/select_option/press_key/drag/evaluate/file_upload）可选人工审批：
  `approveActions: true` 时走 DSH 的 `userQuestions.ask`，人不可达、拒绝或超时都 fail-closed。
  默认 `false` 的理由：P0 是短交互闭环，审批电门在 P1（见 `architecture-framework.md` §5）。
- **零 npm 运行时依赖**：CDP 用 Node 22 全局 WebSocket + fetch；登录态天然复用（连的是已登录 Chrome）。

设计权威见 `knowledge/domains/computer-use/architecture-framework.md`；审批机制见
`knowledge/foundations/tool-approval-interception-and-secrets.md`。

## 怎么生效

1. **无需手动开 Chrome**：`autoLaunch` 默认开，用任一浏览器工具会自动拉起带调试端口的 Chrome
   （独立 profile `~/dsh-browser-profile`，非默认 `--user-data-dir` 是 Chrome ≥136 的强制要求）。
   第一次用它时在弹出的窗口里登录一次账号，之后登录态常驻、重启即复用。想手动开也可：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 --user-data-dir="$HOME/dsh-browser-profile"
   ```
2. 从仓库根目录先运行不依赖宿主 peer 的单元测试，再用 `file:` 安装到目标 profile：
   ```bash
   npm --prefix plugins/manual/dsh-browser-control test
   dsh plugin --profile <name> add "file:$PWD/plugins/manual/dsh-browser-control"
   ```
   进入 profile 的安装副本执行 `node scripts/preflight.mjs`，确认宿主 peer 与所有入口可导入，然后冷启动
   DSH。bundle 插件不会在当前进程中热加载。
3. 模型侧直接用 `browser_navigate` → `browser_snapshot` → `browser_click`/`browser_type` 闭环；
   开启 `approveActions: true` 后敏感动作会弹一次性审批。

## 怎么回滚

```bash
# 移除 plugin 行并重启 DSH 即还原（bundle 插件）：
dsh plugin --profile <name> remove dsh-browser-control   # 之后冷启动 DSH
```

## 待办（承自 roadmap）

- P0 只做「attach 本机已登录 Chrome」；「无头沙箱」由后续 provider 分支补齐。
- `browser_screenshot` 只「截屏落盘 + 返回路径」，读图交给 `modlens_read_image` 等视觉能力（纯文本模型读不了像素，故不接附件管道）。
- HTML5 原生 drag-start/drop 未覆盖（`browser_drag` 是鼠标轨迹拖拽，覆盖滑块/自定义拖拽 UI）。
- 刻意**不含** `execute_cdp` 逃生舱（任意 CDP ≈ 绕过审批与 DOM 抽象，违反 fail-closed）。
