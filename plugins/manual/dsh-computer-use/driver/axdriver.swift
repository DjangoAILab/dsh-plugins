// axdriver — dsh-computer-use 的 macOS Accessibility 辅助进程（阶段①）。
//
// 职责：AXUIElement 树观察——listApps / listWindows / snapshot。
// 动作类（click/type/key/scroll/menu/app）由阶段②在同一进程骨架上扩展。
//
// 协议：stdin 上每行一个 JSON 请求 {"id":N,"op":"...","args":{...}}，
//       stdout 上每行一个 JSON 应答 {"id":N,"ok":true,"result":{...}} 或 {"id":N,"ok":false,"error":"..."}。
//       日志一律走 stderr，禁止污染 stdout（stdout 是协议通道）。
//
// 权限模型（TCC，fail-closed 在 Node 侧 doctor 处理；这里只如实上报）：
//   - 读 AX 树 / 调元素动作 → 需要「辅助功能 Accessibility」授权（授给 DSH 进程链）。
//   - 截屏 → 需要「屏幕录制 Screen Recording」授权（阶段③ screenshot 用）。
//   - AXIsProcessTrusted() 报告本进程是否已被信任；未被信任时 AX 属性读取返回空/错误，
//     doctor 项据此判定，绝不带病工作。
//
// 设计依据：knowledge/domains/computer-use/accessibility-tree-drivers.md §三/§五
// （AX 快照优先、snapshot→ref→action 闭环、driver 是哑执行器）。

import AppKit
import ApplicationServices

// MARK: - 输出

let stdoutLock = NSLock()

func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else {
        stderrWrite("axdriver: dropping non-serializable payload\n")
        return
    }
    stdoutLock.lock()
    // 注意：不要用 FileHandle.synchronizeFile() —— 管道 stdout 上它会抛
    // NSFileHandleOperationException（2026-08-28 实测崩溃）。fputs+fflush 对管道/文件都安全。
    fputs(line + "\n", stdout)
    fflush(stdout)
    stdoutLock.unlock()
}

func stderrWrite(_ text: String) {
    FileHandle.standardError.write(Data(text.utf8))
}

// MARK: - AX 基元

/// 把 AX 属性值转成可 JSON 化的轻量值（字符串/数字/bool；其余转描述串）。
func jsonValue(_ value: CFTypeRef?) -> Any {
    guard let value else { return NSNull() }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as! String }
    if CFGetTypeID(value) == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) }
    if CFGetTypeID(value) == CFNumberGetTypeID() {
        return (value as! NSNumber).doubleValue.truncatingRemainder(dividingBy: 1) == 0
            ? (value as! NSNumber).intValue
            : (value as! NSNumber).doubleValue
    }
    return String(describing: value)
}

/// 读取元素属性；任何失败返回 nil（AX 错误统一吞成 nil，树遍历不允许抛）。
func axAttr(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    var out: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &out) == .success else { return nil }
    return out
}

func axAttrString(_ element: AXUIElement, _ attr: String) -> String? {
    axAttr(element, attr) as? String
}

func axAttrArray(_ element: AXUIElement, _ attr: String) -> [AXUIElement]? {
    guard let arr = axAttr(element, attr) as? [AXUIElement] else { return nil }
    return arr
}

/// 窗口 frame（屏幕坐标系，原点左上）转 JSON：{x,y,width,height}（逻辑点，非像素）。
func axFrame(_ element: AXUIElement) -> [String: Any]? {
    guard let v = axAttr(element, kAXPositionAttribute as String),
          CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    let pos = v as! AXValue
    var p = CGPoint.zero
    AXValueGetValue(pos, .cgPoint, &p)
    guard let s = axAttr(element, kAXSizeAttribute as String),
          CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    let size = s as! AXValue
    var sz = CGSize.zero
    AXValueGetValue(size, .cgSize, &sz)
    return ["x": p.x, "y": p.y, "width": sz.width, "height": sz.height]
}

/// Element 的 pid。
func axPid(_ element: AXUIElement) -> pid_t {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    return pid
}

// MARK: - ref 命名（snapshot 侧约定，与 browser-control 的 ref=@N 同构）

/// 遍历时的路径编码：每层是「第几个子元素」，如 "0/2/1"。动作阶段用它从根重新走位
/// （与 browser-control 每次动作重算 ref 同理：快照与动作自洽，不持有跨调用对象）。
func pathKey(_ path: [Int]) -> String {
    path.map(String.init).joined(separator: "/")
}

// MARK: - 观察操作

/// 正在前台运行的 GUI app 列表（NSWorkspace）。
func listApps() -> [[String: Any]] {
    let ws = NSWorkspace.shared
    let apps = ws.runningApplications.filter {
        $0.activationPolicy == .regular && !$0.isTerminated
    }
    return apps
        .sorted { ($0.localizedName ?? "").lowercased() < ($1.localizedName ?? "").lowercased() }
        .map { app -> [String: Any] in
            var item: [String: Any] = [
                "pid": app.processIdentifier,
                "name": app.localizedName ?? ("pid-\(app.processIdentifier)"),
                "bundleId": app.bundleIdentifier ?? NSNull(),
                "frontmost": app.isActive,
                "hidden": app.isHidden,
            ]
            // AX 侧窗口计数（应用是否真的暴露 AX 树的初步信号）。
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            if let windows = axAttrArray(axApp, kAXWindowsAttribute as String) {
                item["axWindows"] = windows.count
            } else {
                item["axWindows"] = NSNull()
            }
            return item
        }
}

/// 单个 AX 元素的摘要行（含窗口级的 ref 路径）。
func elementSummary(_ element: AXUIElement, _ path: [Int], depth: Int) -> [String: Any] {
    var item: [String: Any] = [
        "ref": "@" + pathKey(path),
        "depth": depth,
    ]
    if let role = axAttrString(element, kAXRoleAttribute as String) { item["role"] = role }
    if let subrole = axAttrString(element, kAXSubroleAttribute as String), !subrole.isEmpty {
        item["subrole"] = subrole
    }
    if let title = axAttrString(element, kAXTitleAttribute as String), !title.isEmpty { item["title"] = title }
    if let value = axAttr(element, kAXValueAttribute as String) { item["value"] = jsonValue(value) }
    if let desc = axAttrString(element, kAXDescriptionAttribute as String), !desc.isEmpty {
        item["description"] = desc
    }
    if let frame = axFrame(element) { item["frame"] = frame }
    // 可执行动作列表（阶段② AXPress 等动作的寻址依据）。
    var names: CFArray?
    if AXUIElementCopyActionNames(element, &names) == .success, let names {
        item["actions"] = (names as? [String]) ?? []
    }
    let focused = axAttr(element, kAXFocusedAttribute as String)
    if let focused, CFGetTypeID(focused) == CFBooleanGetTypeID() {
        item["focused"] = CFBooleanGetValue((focused as! CFBoolean))
    }
    return item
}

/// 深度优先遍历窗口 AX 树。maxDepth/maxNodes 双封顶（防失控树撑爆输出）。
/// 剪枝规则：跳过 AXGroup 之外不透明容器的纯几何子树不存在——AX 树本身已轻量，
/// 封顶策略用「节点预算 + 深度预算」，超限节点折叠成一行省略标记。
func snapshotWindow(_ window: AXUIElement, maxDepth: Int, maxNodes: Int) -> [String: Any] {
    var nodes: [[String: Any]] = []
    var truncated = 0

    func walk(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
        guard depth <= maxDepth else {
            truncated += 1
            return
        }
        guard nodes.count < maxNodes else {
            truncated += 1
            return
        }
        nodes.append(elementSummary(element, path, depth: depth))
        if let children = axAttrArray(element, kAXChildrenAttribute as String) {
            for (i, child) in children.enumerated() {
                var next = path
                next.append(i)
                walk(child, next, depth + 1)
                if nodes.count >= maxNodes { break }
            }
        }
    }

    let rootPath: [Int] = []
    walk(window, rootPath, 0)

    var out: [String: Any] = [
        "nodeCount": nodes.count,
        "nodes": nodes,
    ]
    if let title = axAttrString(window, kAXTitleAttribute as String) { out["title"] = title }
    if let frame = axFrame(window) { out["frame"] = frame }
    if let focusedWindow = axAttrString(window, "AXFocused") { out["focused"] = focusedWindow }
    if truncated > 0 { out["truncatedNodes"] = truncated }
    return out
}

/// 列出一个 app 的窗口（ref 路径约定：窗口本身是 "w<index>"）。
func listWindows(pid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    guard let windows = axAttrArray(app, kAXWindowsAttribute as String) else {
        var unused: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &unused)
        return [
            "windows": [],
            "axError": Int(code.rawValue),
            "hint": code == .cannotComplete
                ? "app 未暴露 AX 树（Electron/Chromium 需 AXManualAccessibility；见 doctor 与 README 坑矩阵）"
                : "app 无可读窗口（可能无窗口或无辅助功能授权）",
        ]
    }
    let list: [[String: Any]] = windows.enumerated().map { (i, w) in
        var item: [String: Any] = ["ref": "w\(i)"]
        if let title = axAttrString(w, kAXTitleAttribute as String) { item["title"] = title }
        if let subrole = axAttrString(w, kAXSubroleAttribute as String) { item["subrole"] = subrole }
        if let frame = axFrame(w) { item["frame"] = frame }
        if let minimized = axAttr(w, kAXMinimizedAttribute as String),
           CFGetTypeID(minimized) == CFBooleanGetTypeID() {
            item["minimized"] = CFBooleanGetValue((minimized as! CFBoolean))
        }
        if let main = axAttr(w, kAXMainAttribute as String),
           CFGetTypeID(main) == CFBooleanGetTypeID() {
            item["main"] = CFBooleanGetValue((main as! CFBoolean))
        }
        return item
    }
    return ["windows": list]
}

// MARK: - 动作原语（阶段②）

/// 沿快照给定的 ref 路径（如 "0/2/1"）从窗口根重新走位到目标元素。
/// 快照与动作自洽：不持有跨调用对象，路径失配（UI 已变）自然报错，与 browser-control 重算 ref 同理。
func resolveByPath(_ window: AXUIElement, _ path: [Int]) -> AXUIElement? {
    var element = window
    for index in path {
        guard let children = axAttrArray(element, kAXChildrenAttribute as String),
              index >= 0, index < children.count else { return nil }
        element = children[index]
    }
    return element
}

/// 对元素执行指定 AX 动作（如 AXPress / AXConfirm / AXShowMenu）。
func performAction(_ element: AXUIElement, _ action: String) -> AXError {
    AXUIElementPerformAction(element, action as CFString)
}

/// 向元素写值（AXValue settable 的文本框等）；需要 app 侧允许 set（部分元素只读会返回 .notAllowed 等）。
func setElementValue(_ element: AXUIElement, _ value: String) -> AXError {
    let cfValue = value as CFTypeRef
    return AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, cfValue)
}

/// 把 app 带到前台（菜单/键击动作的前置）；返回是否成功。
func activateApp(pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    return app.activate(options: [])
}

/// 键盘符号名 → macOS keycode（覆盖常用键；其余直接传单字符）。
let KEY_CODES: [String: UInt16] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

/// 组合键：解析 "cmd+shift+t" / "Return" / "ctrl+a"，经 CGEvent 注入到前台 app。
func postKeyCombo(_ combo: String) throws {
    var flags: CGEventFlags = []
    var keyName = combo.lowercased().trimmingCharacters(in: .whitespaces)
    let modifiers: [(String, CGEventFlags)] = [
        ("cmd", .maskCommand), ("command", .maskCommand),
        ("ctrl", .maskControl), ("control", .maskControl),
        ("alt", .maskAlternate), ("option", .maskAlternate),
        ("shift", .maskShift), ("fn", .maskSecondaryFn),
    ]
    // 逐段剥离修饰键。
    var parts = keyName.split(separator: "+").map(String.init)
    parts = parts.filter { part in
        if let m = modifiers.first(where: { $0.0 == part }) {
            flags.insert(m.1)
            return false
        }
        return true
    }
    guard parts.count == 1, !parts[0].isEmpty else {
        throw DriverError("无法解析组合键: \(combo)（期望形如 cmd+shift+t 或 Return）")
    }
    keyName = parts[0]

    let keyCode: UInt16
    if let known = KEY_CODES[keyName] {
        keyCode = known
    } else if keyName.count == 1, keyName.unicodeScalars.first?.properties.isDefaultIgnorableCodePoint == false {
        // 单字符：直接走「按字符注入」路径——UCKeyTranslate 布局翻译复杂且对非英文布局易错，
        // unicode 注入等价且稳定（调研结论 accessibility-tree-drivers.md §三：driver 是哑执行器，从简）。
        try postUnicodeString(keyName)
        return
    } else {
        // 多字符符号名（未收录）→ 整串按字符注入。
        try postUnicodeString(keyName)
        return
    }

    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw DriverError("CGEvent 创建失败: \(combo)")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(12_000)
    up.post(tap: .cghidEventTap)
}

/// 按字符注入任意文本（unicode 串），不走 keycode。
func postUnicodeString(_ text: String) throws {
    for scalar in text.unicodeScalars {
        var chars = [UniChar(scalar.value)]
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw DriverError("CGEvent 创建失败（unicode 注入）")
        }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
        down.post(tap: .cghidEventTap)
        usleep(6_000)
        up.post(tap: .cghidEventTap)
    }
}

struct DriverError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// 坐标点击（CGEvent）：先移鼠标再按下/抬起。moveFirst=true 时做一次显式移动。
func postClick(x: CGFloat, y: CGFloat, button: CGMouseButton = .left, clicks: Int = 1) throws {
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button),
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button) else {
        throw DriverError("CGEvent 创建失败（mouse）")
    }
    move.post(tap: .cghidEventTap)
    usleep(20_000)
    down.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    down.post(tap: .cghidEventTap)
    usleep(12_000)
    up.post(tap: .cghidEventTap)
}

/// 滚轮滚动（正=向上/左，负=向下/右）。
func postScroll(x: CGFloat, y: CGFloat, dx: Int32, dy: Int32) throws {
    guard let event = CGEvent(source: nil) else {
        throw DriverError("CGEvent 创建失败（scroll）")
    }
    event.location = CGPoint(x: x, y: y)
    event.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy))
    event.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(dx))
    event.post(tap: .cghidEventTap)
}

/// AXError → 人类可读描述（写进 reply.error 帮助模型自愈）。
func axErrorText(_ code: AXError, op: String) -> String {
    switch code {
    case .success: return "success"
    case .cannotComplete: return "cannotComplete（app 未响应 AX 请求）"
    case .attributeUnsupported: return "attributeUnsupported（元素不支持该属性）"
    case .actionUnsupported: return "actionUnsupported（元素不支持该动作）"
    case .notificationUnsupported: return "notificationUnsupported"
    case .invalidUIElement: return "invalidUIElement（UI 已变化，ref 路径失配；重新 snapshot）"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    default: return "axError=\(code.rawValue)（常见于值只读 set 被拒或元素已失效）"
    }
}

/// 按菜单路径点菜单栏项：如 ["文件", "新建"]。
/// 注意：AXMenuBar 只对「正在前台的 app」可读（menu bar 属于前台会话），调用侧必须先 activate。
/// 坑（2026-08-28 实测）：AXMenuBar 返回的是**单个 menu bar 元素**（CFTypeID=AXUIElement），
/// 不是元素数组——`as? [AXUIElement]` 会静默失败，必须按单元素处理（与 AXWindows 不同）。
func clickMenu(pid: pid_t, path: [String]) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    let barElement: AXUIElement?
    if let single = axAttr(app, "AXMenuBar"), CFGetTypeID(single) == AXUIElementGetTypeID() {
        barElement = (single as! AXUIElement)
    } else if let arr = axAttrArray(app, "AXExtrasMenuBar"), let first = arr.first {
        barElement = first
    } else {
        barElement = nil
    }
    guard let bar = barElement else {
        return ["error": "app pid=\(pid) 读不到 AXMenuBar（menu bar 只对前台 app 可读；需先 activate，或授权缺失）"]
    }
    var element: AXUIElement = bar
    var walked: [String] = []
    for (i, title) in path.enumerated() {
        // 顶层菜单（i=0）的子项直接是 menu bar 的 children；进入下一层后子项挂在
        // AXMenu role 的子元素下（2026-08-28 实测：菜单项 title 在 AXMenu.children 里）。
        var items: [AXUIElement]
        if i == 0 {
            items = axAttrArray(element, kAXChildrenAttribute as String) ?? []
        } else {
            let children = axAttrArray(element, kAXChildrenAttribute as String) ?? []
            // 找 AXMenu role 的子元素（点开后才挂上），从它拿菜单项；没有则用 element 自身 children。
            if let menu = children.first(where: {
                (axAttrString($0, kAXRoleAttribute as String)) == "AXMenu"
            }), let menuItems = axAttrArray(menu, kAXChildrenAttribute as String) {
                items = menuItems
            } else {
                items = children
            }
        }
        if items.isEmpty {
            return ["error": "菜单层级 \(i)（\(walked.joined(separator: " > "))) 无子项（子菜单可能未展开）"]
        }
        var matched: AXUIElement? = nil
        for item in items {
            let t = axAttrString(item, kAXTitleAttribute as String) ?? axAttrString(item, kAXDescriptionAttribute as String)
            if t == title {
                matched = item
                break
            }
        }
        guard let hit = matched else {
            let available: [String] = items.compactMap {
                let t = axAttrString($0, kAXTitleAttribute as String) ?? axAttrString($0, kAXDescriptionAttribute as String)
                return (t?.isEmpty == false) ? t : axAttrString($0, kAXRoleAttribute as String)
            }
            return ["error": "菜单「\(title)」未找到（层级 \(i)，在 \(walked.isEmpty ? "菜单栏" : walked.joined(separator: " > "))）；可用项: \(available.prefix(15).joined(separator: "、"))"]
        }
        // 中间层：先 AXPress 展开子菜单再下钻；最后一层：AXPress 触发。
        let code = AXUIElementPerformAction(hit, kAXPressAction as CFString)
        if i < path.count - 1 {
            guard code == .success else {
                return ["error": "展开菜单「\(title)」失败: axError=\(code.rawValue)"]
            }
            usleep(120_000) // 等子菜单挂载
        }
        element = hit
        walked.append(title)
    }
    return ["ok": true, "path": walked]
}

// MARK: - 请求循环

func handle(_ request: [String: Any]) -> [String: Any] {
    let id = (request["id"] as? NSNumber) ?? 0
    let op = request["op"] as? String ?? ""

    func reply(_ result: [String: Any]) -> [String: Any] {
        ["id": id, "ok": true, "result": result]
    }
    func fail(_ message: String) -> [String: Any] {
        ["id": id, "ok": false, "error": message]
    }

    switch op {
    case "ping":
        return reply([
            "pong": true,
            "trusted": AXIsProcessTrusted(),
            "sdk": ProcessInfo.processInfo.operatingSystemVersionString,
        ])
    case "doctor":
        // 权限事实上报（判定在 Node 侧）：辅助功能授权与否、AX 是否可用。
        var out: [String: Any] = [
            "axTrusted": AXIsProcessTrusted(),
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let front = NSWorkspace.shared.frontmostApplication {
            out["frontApp"] = ["pid": front.processIdentifier, "name": front.localizedName ?? ""]
        }
        return reply(out)
    case "listApps":
        return reply(["apps": listApps()])
    case "listWindows":
        guard let args = request["args"] as? [String: Any],
              let pid = (args["pid"] as? NSNumber)?.intValue else {
            return fail("listWindows 需要 args.pid（来自 computer_list_apps）")
        }
        return reply(listWindows(pid: pid_t(pid)))
    case "snapshot":
        guard let args = request["args"] as? [String: Any] else {
            return fail("snapshot 需要 args")
        }
        guard let pid = (args["pid"] as? NSNumber)?.intValue else {
            return fail("snapshot 需要 args.pid")
        }
        let windowIndex = (args["windowIndex"] as? NSNumber)?.intValue ?? 0
        let maxDepth = (args["maxDepth"] as? NSNumber)?.intValue ?? 18
        let maxNodes = (args["maxNodes"] as? NSNumber)?.intValue ?? 800
        let app = AXUIElementCreateApplication(pid_t(pid))
        guard let windows = axAttrArray(app, kAXWindowsAttribute as String), !windows.isEmpty else {
            return fail("app pid=\(pid) 无可读窗口（无 AX 树或无授权；先跑 doctor，Electron 类见 README 坑矩阵）")
        }
        guard windowIndex >= 0, windowIndex < windows.count else {
            return fail("windowIndex \(windowIndex) 超界：app pid=\(pid) 有 \(windows.count) 个窗口")
        }
        var out = snapshotWindow(windows[windowIndex], maxDepth: maxDepth, maxNodes: maxNodes)
        out["windowIndex"] = windowIndex
        out["windowCount"] = windows.count
        out["pid"] = pid
        return reply(out)

    // ---- 阶段②动作 op ----

    case "click":
        guard let args = request["args"] as? [String: Any],
              let pid = (args["pid"] as? NSNumber)?.intValue else {
            return fail("click 需要 args.pid")
        }
        let windowIndex = (args["windowIndex"] as? NSNumber)?.intValue ?? 0
        let action = (args["action"] as? String) ?? "AXPress"
        let app = AXUIElementCreateApplication(pid_t(pid))
        guard let windows = axAttrArray(app, kAXWindowsAttribute as String), !windows.isEmpty,
              windowIndex >= 0, windowIndex < windows.count else {
            return fail("click：app pid=\(pid) 无可读窗口或 windowIndex 超界")
        }
        // 优先 ref 路径寻址；给 x/y 时走坐标点击（CGEvent，屏幕坐标系逻辑点）。
        if let ref = args["ref"] as? String, ref.hasPrefix("@") {
            let parts = ref.dropFirst().split(separator: "/").compactMap { Int($0) }
            guard let element = resolveByPath(windows[windowIndex], parts) else {
                return fail("ref \(ref) 解析失败（UI 已变化？重新 computer_snapshot）")
            }
            let code = performAction(element, action)
            guard code == .success else {
                return fail("AX 动作 \(action) 失败: \(axErrorText(code, op: "click"))；可尝试 x/y 坐标兜底")
            }
            return reply(["mode": "ax", "ref": ref, "action": action])
        }
        if let x = (args["x"] as? NSNumber)?.doubleValue,
           let y = (args["y"] as? NSNumber)?.doubleValue {
            do {
                try postClick(x: x, y: y)
                return reply(["mode": "coordinate", "x": x, "y": y])
            } catch {
                return fail(String(describing: error))
            }
        }
        return fail("click 需要 args.ref（来自 computer_snapshot）或 args.x/args.y")

    case "type":
        guard let args = request["args"] as? [String: Any],
              let pid = (args["pid"] as? NSNumber)?.intValue else {
            return fail("type 需要 args.pid")
        }
        guard let text = args["text"] as? String else {
            return fail("type 需要 args.text")
        }
        let windowIndex = (args["windowIndex"] as? NSNumber)?.intValue ?? 0
        let app = AXUIElementCreateApplication(pid_t(pid))
        guard let windows = axAttrArray(app, kAXWindowsAttribute as String), !windows.isEmpty,
              windowIndex >= 0, windowIndex < windows.count else {
            return fail("type：app pid=\(pid) 无可读窗口或 windowIndex 超界")
        }
        // ref 给定 → 目标元素 set value（可写时）+ 附加键入；否则整段按字符注入到焦点元素。
        if let ref = args["ref"] as? String, ref.hasPrefix("@") {
            let parts = ref.dropFirst().split(separator: "/").compactMap { Int($0) }
            guard let element = resolveByPath(windows[windowIndex], parts) else {
                return fail("ref \(ref) 解析失败（UI 已变化？重新 computer_snapshot）")
            }
            let setCode = setElementValue(element, text)
            if setCode == .success {
                return reply(["mode": "ax-set", "ref": ref, "length": text.count])
            }
            // set 失败（只读等）→ 退回聚焦 + unicode 注入。
            let focusCode = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard focusCode == .success else {
                return fail("set value 失败: \(axErrorText(setCode, op: "type"))；聚焦也失败: \(axErrorText(focusCode, op: "type"))")
            }
        }
        do {
            try postUnicodeString(text)
            return reply(["mode": "unicode-inject", "length": text.count])
        } catch {
            return fail(String(describing: error))
        }

    case "key":
        guard let args = request["args"] as? [String: Any],
              let combo = args["combo"] as? String, !combo.isEmpty else {
            return fail("key 需要 args.combo（如 return / cmd+shift+t / ctrl+a）")
        }
        do {
            try postKeyCombo(combo)
            return reply(["combo": combo])
        } catch {
            return fail(String(describing: error))
        }

    case "scroll":
        guard let args = request["args"] as? [String: Any] else { return fail("scroll 需要 args") }
        guard let dy = (args["dy"] as? NSNumber)?.intValue else {
            return fail("scroll 需要 args.dy（正=上，负=下）")
        }
        let dx = (args["dx"] as? NSNumber)?.intValue ?? 0
        let x = (args["x"] as? NSNumber)?.doubleValue ?? CGFloat(NSScreen.main?.frame.midX ?? 0)
        let y = (args["y"] as? NSNumber)?.doubleValue ?? CGFloat(NSScreen.main?.frame.midY ?? 0)
        do {
            try postScroll(x: x, y: y, dx: Int32(dx), dy: Int32(dy))
            return reply(["dx": dx, "dy": dy])
        } catch {
            return fail(String(describing: error))
        }

    case "menu":
        guard let args = request["args"] as? [String: Any],
              let pid = (args["pid"] as? NSNumber)?.intValue else {
            return fail("menu 需要 args.pid")
        }
        guard let rawPath = args["path"] as? [Any],
              !rawPath.isEmpty,
              let path = rawPath.compactMap({ $0 as? String }) as [String]?, path.count == rawPath.count else {
            return fail("menu 需要 args.path（菜单路径数组，如 [\"文件\",\"新建\"]）")
        }
        if args["activate"] as? Bool ?? true {
            _ = activateApp(pid: pid_t(pid))
            usleep(80_000) // 等 app 真正到前台再点菜单
        }
        let out = clickMenu(pid: pid_t(pid), path: path)
        if let error = out["error"] as? String { return fail(error) }
        return reply(out)

    case "app":
        guard let args = request["args"] as? [String: Any],
              let verb = args["verb"] as? String else {
            return fail("app 需要 args.verb（launch/activate/quit）")
        }
        switch verb {
        case "launch":
            guard let bundleId = args["bundleId"] as? String, !bundleId.isEmpty else {
                return fail("launch 需要 args.bundleId（如 com.apple.TextEdit）")
            }
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
                return fail("找不到 bundleId=\(bundleId) 对应的 app")
            }
            // openApplicationAtURL 是 macOS 11+ 推荐异步 API；launchApplication(at:) 已弃用。
            let semaphore = DispatchSemaphore(value: 0)
            var launchError: String? = nil
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error { launchError = error.localizedDescription }
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 15) == .success else {
                return fail("launch 超时（15s）: \(bundleId)")
            }
            if let launchError {
                return fail("launch 失败: \(launchError)")
            }
            return reply(["verb": "launch", "bundleId": bundleId])
        case "activate":
            guard let pid = (args["pid"] as? NSNumber)?.intValue else {
                return fail("activate 需要 args.pid")
            }
            guard activateApp(pid: pid_t(pid)) else {
                return fail("activate 失败：pid=\(pid) 不可激活（已退出或后台限定）")
            }
            return reply(["verb": "activate", "pid": pid])
        case "quit":
            guard let pid = (args["pid"] as? NSNumber)?.intValue else {
                return fail("quit 需要 args.pid")
            }
            guard let running = NSRunningApplication(processIdentifier: pid_t(pid)) else {
                return fail("quit 失败：pid=\(pid) 不在运行")
            }
            // 优雅退出（触发未保存提示），不 SIGTERM 强杀。
            running.terminate()
            return reply(["verb": "quit", "pid": pid])
        default:
            return fail("未知 verb: \(verb)（支持 launch/activate/quit）")
        }
    default:
        return fail("unknown op: \(op)（支持 ping/doctor/listApps/listWindows/snapshot/click/type/key/scroll/menu/app）")
    }
}

// 主循环：stdout 彻底留给协议；行缓冲读 stdin，EOF 退出。
func main() {
    setvbuf(stdout, nil, _IOLBF, 0)
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            emit(["id": 0, "ok": false, "error": "malformed request line"])
            continue
        }
        emit(handle(request))
    }
}

main()
