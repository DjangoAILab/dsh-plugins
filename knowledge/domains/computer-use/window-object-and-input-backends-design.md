# 窗口对象化与输入后端分层设计（v0.2.0）

> 状态：**v0.2.0 已交付并通过自动化测试与隔离的 macOS 功能复核**；windowId 句柄、多窗口稳定性与
> snapshot 新签名均已覆盖。Tier 1 虚拟指针仍不交付，spike 前置条件与门槛保留在文内，启用前需按
> 目标 macOS 版本重新评估。
> 现状基线：v0.1.1 使用 pid+AXWindows 数组序号（每次重读），截图走独立 CGWindowList 探针
> （与 AX 排序不同源），鼠标/键盘全走全局 .cghidEventTap。

## ADR-1：窗口身份 = driver 会话作用域的不透明句柄

`windowId = win_<driver-instance-nonce>_<monotonic-seq>`（如 `win_7k2m9q_1`）。

- driver 进程内维护 WindowRegistry：{ windowId, pid, **retained AXUIElement**, title,
  frame, minimized, main, focused, cgWindowNumber?, lastSeenAt }。
- nonce 让 driver 重启后的旧句柄明确报 `WINDOW_SESSION_EXPIRED`，绝不让旧 `w1`
  意外命中新进程里的另一扇窗。
- 排除的候选：CGWindowNumber 作身份（最小化/Space 影响可见性、关闭后复用、AX/CG 无
  公开映射）；pid+title+frame 指纹（同题同尺寸重叠窗不可分、移动/改题即失效）。
- 保留 AXUIElement 代价低（几十个窗口量级）；窗口关闭后的 `invalidUIElement` 正好是
  可靠失效信号。

### 签发与 reconcile（只有 computer_windows 签发新 ID）

1. 读 AXWindows；2. 用 `CFEqual`（AXUIElement 是 CFType）与既有 entry 对齐沿用旧 ID；
3. 新 element 分配新 ID；4. 完整重列中消失的 entry 转 tombstone；
5. `cannotComplete` 是暂时不可响应，不得据此删句柄。

### CG 截图绑定（CGWindowNumber 只是 capture binding，不是身份）

listWindows 同时读一次 CGWindowList（并入长驻 driver，**删除独立 winid 探针**）；
pid+layer=0 过滤后按 frame/title 匹配，唯一匹配才记录，并列即 `captureAvailable:false`
绝不猜；截图前重核 pid/title/frame，不符报 `WINDOW_CAPTURE_STALE`；最小化无 CG 记录报
`WINDOW_NOT_CAPTURABLE`。

## ADR-2：工具面（v0.2.0 clean break）

| 工具 | v0.2.0 参数 | 变化 |
| --- | --- | --- |
| computer_windows | pid?（省略 = 全部 GUI app 的窗口） | pid 必填→可选 |
| computer_snapshot | windowId, maxDepth?, maxNodes? | 删 pid+windowIndex |
| computer_click | windowId?, ref?, action?, x?, y?, inputMode? | ref 模式必须带 windowId |
| computer_type | text, windowId?, ref?, inputMode? | 同上 |
| computer_key / computer_scroll | …, windowId?, inputMode? | 新增可选 windowId |
| computer_screenshot | mode, windowId?, maxDimension? | window 模式必须 windowId |
| **computer_window**（新） | windowId, verb, x?, y?, width?, height? | 窗口操作单工具 |

- `computer_window.verb`：activate（AXRaise+激活 app，抢全局焦点）/ raise（仅 AXRaise）/
  close（AXCloseButton AXPress，"发出关闭请求"，保存框可能让窗继续存在）/ minimize /
  restore（AXMinimized set + 读回验证）/ move（AXPosition）/ resize（AXSize）。
- **不做单独 focus verb**：AXMain≠全局键盘焦点，会误导模型；窗口级真实聚焦由 activate 表达。
- 单工具 vs 多工具：窗口管理动作共享目标/错误/审批语义，一个 computer_window 省
  工具预算；不建议拆 7 个。
- clean break 不留 pid+windowIndex fallback（pre-1.0 单消费者，fallback 保留最危险的
  「索引选错窗」路径）；v0.1.1 包即回滚方案。

## ADR-3：失效策略 = Pull（不做 AXObserver）

每次 windowId 操作前：nonce 校验 → registry 查 active/tombstone → pid 仍活着 →
AXUIElement 轻量属性读探活。`invalidUIElement` → 立即 tombstone + 释放 AX 引用 + 返回
`[WINDOW_GONE] 重新 computer_windows`；`cannotComplete` → 可重试 `WINDOW_TRANSIENT`
（不能删句柄）；unsupported 只是能力缺失不是窗口死亡。tombstone 保留最近 256 项 / 10 分钟
（无 AX 引用）。

不做 push 的理由：AXObserver 必须挂 run loop（当前 driver 是阻塞 readLine 循环）；
每 app 一个 observer 的生命周期/线程/锁复杂度；DSH 工具契约没有异步推送通道；AX 通知
可靠性不齐、最终仍要 action-time 探活。成本 > 收益。

## ADR-4：输入后端分层（虚拟指针的真实边界）

| Tier | 实现 | 光标 | 后台 | 关键限制 |
| --- | --- | --- | --- | --- |
| 0 | AX action / AXValue set | 不占用 | 通常可 | 依赖 app 暴露 AX；安全 UI 不行 |
| 1 | CGEventPostToPid（macOS 10.11+，未废弃） | 通常不移动（无契约保证） | 可尝试 | **API 返回 void 无回执**；app 可静默忽略；键盘仍归 app 的 key window/first responder |
| 2 | CGEventPost → session/HID tap | 占用真实光标 | 否 | 干扰用户 |

- **并行能力的真相**：一个登录会话只有一个光标 + 一个全局键盘焦点。Tier 1 提供的是
  「后台定向投递 + 用户真实光标不被移动」，**不是两套独立桌面**；同 app 多窗共享
  key-window 状态，两路键盘流不能安全并发；driver 单循环继续串行（isConcurrencySafe:false 保留）。
- inputMode = auto(默认) / cursorless(仅 Tier 0/1) / global(强制 Tier 2)；配置
  `pidTargetedInput: false`（v0.2 初始默认关）。
- fallback 纪律：Tier 0 明确 unsupported 才降级；`cannotComplete` **绝不 fallback**
  （动作可能已执行，重发=双击/重复提交）；Tier 2 带 windowId 前必须确认目标是全局前台，
  否则 `NEEDS_ACTIVATION`。
- 统一成功输出：`mode: ax-action|ax-value|pid-cgevent|global-cgevent` +
  `delivery: acknowledged|posted-unverified`（CGEvent 永远 posted-unverified，
  动作后 snapshot/截图才是验证）。
- 错误带稳定 code：WINDOW_SESSION_EXPIRED / WINDOW_UNKNOWN / WINDOW_GONE /
  WINDOW_TRANSIENT / WINDOW_CAPTURE_AMBIGUOUS / WINDOW_NOT_CAPTURABLE /
  INPUT_BACKEND_DISABLED / INPUT_TARGET_NOT_FOCUSED / INPUT_UNSUPPORTED /
  INPUT_POST_ACCESS_DENIED；doctor 增加 CGPreflightPostEventAccess()。

### Windows 映射（只留接口形状，不实现）

windowId→HWND（同样不裸暴露，HWND 销毁后复用）；Tier 0→UIA patterns；Tier 1→
PostMessage/SendMessage（client coords，raw input/DirectInput/GetAsyncKeyState 类 app
不可靠——与 macOS Tier 1 同定位）；Tier 2→SendInput（UIPI 完整性级别限制）。

## 虚拟指针采用结论

**Spike first（1-2 人日，不进正式工具面）→ 通过后以实验开关交付 → 暂不默认启用。**
Spike 矩阵：TextEdit 双窗 / Safari / 一个 Electron app / 前台真人动鼠标时记录全局光标
位移 / 同题多窗遮挡最小化切 Space / TCC 开关 / hover+组合键+Unicode+滚动；每次动作后用
AX/snapshot 验证而非函数返回。通过门槛：原生 app 正确目标率接近确定、零光标位移、
零错投；Electron 可标不支持但不能静默错投。
Top3 风险：①PostToPid void 无回执，静默拒不可自动检测；②pid 定向≠window 定向
（键盘走 key window）；③app/framework 差异大。

## 分期（总量约 7-11 人日）

| 阶段 | 交付 | 估 |
| --- | --- | ---: |
| Spike | Tier 1 兼容矩阵 + 门槛实测 | 1-2 |
| v0.2-A | WindowRegistry + nonce + reconcile/tombstone + 结构化错误 | 2-3 |
| v0.2-B | 新工具 schema + computer_window + windowId 迁移 | 2-3 |
| v0.2-C | CG 枚举并入 driver + 截图 binding + 删 winid probe | 1-2 |
| v0.2-D | InputBackend 层（Tier 0/2 迁移 + mode/delivery 统一） | 1-2 |
| v0.2-E | Tier 1 实验（spike 通过后，默认关） | 1-2 |
| 测试/文档 | 92 项保持全绿 + registry/失效/歧义/fallback 新测试 | 1-2 |

开放问题（spike 回答前按 fail-closed 设计）：重叠多窗的定向 mouse 分派、后台设
AXMain/AXFocused 对 key window 的有效性、代表性 Electron app 对定向 CGEvent 的接受度。
