// axdriver — dsh-computer-use 的 macOS Accessibility 辅助进程（v0.2.0 窗口对象化）。
//
// 职责：AXUIElement 树观察 + 窗口注册表（WindowRegistry）+ 输入动作。
//   - listWindows 签发不透明 windowId（win_<nonce>_<seq>），reconcile 沿用旧 ID，
//     消失窗口转 tombstone（ADR-1）；同时并入 CGWindowList 截图绑定（v0.2-C，
//     替代独立 winid 探针）。
//   - snapshot / windowAction / click / type 按 windowId 解析 retained AXUIElement，
//     每次操作前 pull 探活（ADR-3，不做 AXObserver）。
//   - key/scroll/坐标点击保持 Tier 2 全局 CGEvent；Tier 1（CGEventPostToPid）
//     明确未实现——inputMode=cursorless 只服务 Tier 0，缺 Tier 0 能力报
//     INPUT_UNSUPPORTED，绝不静默降级（ADR-4 fallback 纪律）。
//
// 协议：stdin 上每行一个 JSON 请求 {"id":N,"op":"...","args":{...}}，
//       stdout 上每行一个 JSON 应答 {"id":N,"ok":true,"result":{...}} 或
//       {"id":N,"ok":false,"error":"...","code":"...","retryable":false,"recovery":"..."}。
//       日志一律走 stderr，禁止污染 stdout（stdout 是协议通道）。
//
// 权限模型（TCC，fail-closed 在 Node 侧 doctor 处理；这里只如实上报）：
//   - 读 AX 树 / 调元素动作 → 需要「辅助功能 Accessibility」授权（授给 DSH 进程链）。
//   - 截屏 / CGWindowList 的 kCGWindowName → 需要「屏幕录制 Screen Recording」授权；
//     无授权时 CG 窗口名缺席，capture 绑定退化为纯 frame 匹配（并列即不绑）。
//
// 设计依据：knowledge/domains/computer-use/window-object-and-input-backends-design.md
// （ADR-1..ADR-4）；accessibility-tree-drivers.md §三/§五。

import AppKit
import ApplicationServices
import Security

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

// MARK: - 实例 nonce（ADR-1：driver 重启后旧句柄必须明确失效）

/// 6 字符 base36 随机 nonce：windowId 前缀带它，跨进程绝不串窗。
func genInstanceNonce() -> String {
    let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    var bytes = [UInt8](repeating: 0, count: 6)
    // SecRandomCopyBytes 优先（密码学随机）；失败（极少）退回 Swift 内置随机，仍足够防碰撞。
    let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 6, $0.baseAddress!) }
    if status != errSecSuccess {
        for i in 0..<6 { bytes[i] = UInt8.random(in: 0...255) }
    }
    return String(bytes.map { alphabet[Int($0) % 36] })
}

let INSTANCE_NONCE = genInstanceNonce()

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

func axAttrBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    guard let v = axAttr(element, attr), CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((v as! CFBoolean))
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
    return ["x": Double(p.x), "y": Double(p.y), "width": Double(sz.width), "height": Double(sz.height)]
}

/// Element 的 pid。
func axPid(_ element: AXUIElement) -> pid_t {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    return pid
}

// MARK: - WindowRegistry（ADR-1）

/// 窗口注册表条目：windowId 是唯一身份，retained AXUIElement 是操作句柄，
/// cgWindowNumber 只是截图绑定（CGWindowNumber 重用/重排，绝不当身份用）。
final class WindowEntry {
    let windowId: String
    let pid: pid_t
    let element: AXUIElement
    var title: String?
    var frame: [String: Any]?
    var minimized: Bool?
    var main: Bool?
    var focused: Bool?
    var cgWindowNumber: Int?
    var captureAvailable: Bool = false
    var lastSeenAt: Date = Date()

    init(windowId: String, pid: pid_t, element: AXUIElement) {
        self.windowId = windowId
        self.pid = pid
        self.element = element
    }

    /// 从元素刷新缓存属性（title/frame/minimized/main/focused）；单属性读失败保留旧值。
    func refresh() {
        if let t = axAttrString(element, kAXTitleAttribute as String) { title = t }
        if let f = axFrame(element) { frame = f }
        if let m = axAttrBool(element, kAXMinimizedAttribute as String) { minimized = m }
        if let m = axAttrBool(element, kAXMainAttribute as String) { main = m }
        if let f = axAttrBool(element, kAXFocusedAttribute as String) { focused = f }
        lastSeenAt = Date()
    }

    /// QA 终轮（resolveCapture 错绑修复）：错误感知版刷新——title/frame 是截图绑定的
    /// 匹配键，读取失败时**绝不沿用缓存值**（旧 title/frame 可能已被同 pid 其他窗口占据，
    /// 拿去匹配会错绑 CGWindowNumber）。invalidUIElement → .gone；cannotComplete →
    /// .transient；单属性 unsupported → 该属性按缺失处理（nil），不整体失败。
    enum RefreshOutcome { case ok, gone, transient }
    func refreshStrict() -> RefreshOutcome {
        // title：三态读取。
        var out: CFTypeRef?
        let titleCode = AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &out)
        switch titleCode {
        case .invalidUIElement: return .gone
        case .cannotComplete: return .transient
        default: break
        }
        let newTitle: String? = titleCode == .success ? (out as? String) : nil
        // frame：position+size 三态读取（任一 invalidUIElement → gone；cannotComplete → transient）。
        var posOut: CFTypeRef?
        var sizeOut: CFTypeRef?
        let posCode = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posOut)
        if posCode == .invalidUIElement { return .gone }
        if posCode == .cannotComplete { return .transient }
        let sizeCode = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeOut)
        if sizeCode == .invalidUIElement { return .gone }
        if sizeCode == .cannotComplete { return .transient }
        var newFrame: CGRect?
        if posCode == .success, sizeCode == .success,
           let posV = posOut, CFGetTypeID(posV) == AXValueGetTypeID(),
           let sizeV = sizeOut, CFGetTypeID(sizeV) == AXValueGetTypeID() {
            let pos = posV as! AXValue
            var p = CGPoint.zero
            AXValueGetValue(pos, .cgPoint, &p)
            let size = sizeV as! AXValue
            var sz = CGSize.zero
            AXValueGetValue(size, .cgSize, &sz)
            newFrame = CGRect(x: p.x, y: p.y, width: sz.width, height: sz.height)
        }
        title = newTitle
        // frame 缓存字段是 [String: Any]（与 axFrame 输出同构），非 CGRect。
        frame = newFrame.map { ["x": $0.origin.x, "y": $0.origin.y, "width": $0.width, "height": $0.height] }
        lastSeenAt = Date()
        return .ok
    }

    /// listWindows 输出项（可空字段条件性存在，Node 侧 schema additionalProperties:false）。
    func summary(appName: String) -> [String: Any] {
        var item: [String: Any] = [
            "windowId": windowId,
            "pid": Int(pid),
            "appName": appName,
            "captureAvailable": captureAvailable,
        ]
        if let t = title, !t.isEmpty { item["title"] = t }
        if let f = frame { item["frame"] = f }
        if let m = minimized { item["minimized"] = m }
        if let m = main { item["main"] = m }
        if let f = focused { item["focused"] = f }
        return item
    }
}

/// 活跃句柄表：windowId → entry（entry 持有 retained AXUIElement，量级几十个窗口，代价低）。
var gRegistry: [String: WindowEntry] = [:]
var gWindowSeq = 0

/// tombstone 环形缓冲：已消失窗口的身份证残片（无 AX 引用），用于给旧句柄报准错
/// WINDOW_GONE 而不是含糊 WINDOW_UNKNOWN。上限 256 条 / 10 分钟 TTL（ADR-3）。
struct WindowTombstone {
    let windowId: String
    let pid: pid_t
    let buriedAt: Date
}
var gTombstones: [WindowTombstone] = []
let TOMBSTONE_MAX = 256
let TOMBSTONE_TTL: TimeInterval = 600

func bury(_ entry: WindowEntry, now: Date = Date()) {
    // QA FIX-5：TTL 不只在 listWindows 生效——埋点时顺带清理过期 tombstone，
    // 保证任何操作路径（含从不重列的长会话）都不会让过期条目无限累积。
    purgeTombstones(now: now)
    gRegistry.removeValue(forKey: entry.windowId)
    gTombstones.append(WindowTombstone(windowId: entry.windowId, pid: entry.pid, buriedAt: now))
    if gTombstones.count > TOMBSTONE_MAX {
        gTombstones.removeFirst(gTombstones.count - TOMBSTONE_MAX)
    }
}

func purgeTombstones(now: Date = Date()) {
    gTombstones.removeAll { now.timeIntervalSince($0.buriedAt) > TOMBSTONE_TTL }
}

func isTombstoned(_ windowId: String) -> Bool {
    // QA FIX-5：tombstone 查找（resolveWindowEntry 的调用点）同样先清过期——
    // 超过 TTL 的旧句柄应报 WINDOW_UNKNOWN（身份残片已过期），而不是永远 WINDOW_GONE。
    purgeTombstones()
    return gTombstones.contains { $0.windowId == windowId }
}

func newWindowId() -> String {
    gWindowSeq += 1
    return "win_\(INSTANCE_NONCE)_\(gWindowSeq)"
}

func appNameForPid(_ pid: pid_t) -> String {
    NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid-\(pid)"
}

// MARK: - CGWindowList 截图绑定（v0.2-C：并入 driver，替代独立 winid 探针）

struct CGWinInfo {
    let number: Int
    let pid: pid_t
    let name: String?   // 无屏幕录制授权时缺席
    let frame: [String: Any]  // kCGWindowBounds → {x,y,width,height}
}

/// on-screen + layer==0 的常规窗口（排除桌面元素与菜单/停靠等分层窗口）。
func cgWindowListAll() -> [CGWinInfo] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [CGWinInfo] = []
    for w in list {
        guard let layer = (w["kCGWindowLayer"] as? NSNumber)?.intValue, layer == 0 else { continue }
        guard let pid = (w["kCGWindowOwnerPID"] as? NSNumber)?.int32Value else { continue }
        guard let num = (w["kCGWindowNumber"] as? NSNumber)?.intValue else { continue }
        var frame: [String: Any] = [:]
        if let b = w["kCGWindowBounds"] as? [String: Any] {
            for (k, key) in [("X", "x"), ("Y", "y"), ("Width", "width"), ("Height", "height")] {
                if let v = (b[k] as? NSNumber)?.doubleValue { frame[key] = v }
            }
        }
        let name = w["kCGWindowName"] as? String
        out.append(CGWinInfo(number: num, pid: pid, name: name, frame: frame))
    }
    return out
}

func cgNumber(_ v: Any?) -> Double? {
    (v as? NSNumber)?.doubleValue
}

/// AX frame 与 CG bounds 对齐（逻辑点，容差 2pt 吸收取整差）。
func framesMatch(_ a: [String: Any]?, _ b: [String: Any]?, tolerance: Double = 2.0) -> Bool {
    guard let a, let b else { return false }
    for key in ["x", "y", "width", "height"] {
        guard let va = cgNumber(a[key]), let vb = cgNumber(b[key]) else { return false }
        if abs(va - vb) > tolerance { return false }
    }
    return true
}

/// frame+title 匹配：唯一命中才返回（ADR-1「并列绝不猜」）。
/// QA FIX-2 绑定纪律：AX title 非空且 CG 候选带可用窗名（kCGWindowName 非空）时，**必须**
/// title 精确一致才允许绑定——同尺寸不同题的窗口绝不能按 frame 拍绑；只有全部候选都没有
/// 可用 CG 窗名（无屏幕录制授权 / 该窗口类型 CG 名合法为空）时才退化为纯 frame 唯一匹配。
/// 歧义（多个 frame 命中、或多个 title 命中、或有候选 title 不符）一律返回 nil。
func matchCGWindow(title: String?, frame: [String: Any]?, in cgList: [CGWinInfo]) -> CGWinInfo? {
    guard let frame else { return nil }
    let candidates = cgList.filter { framesMatch(frame, $0.frame) }
    if candidates.isEmpty { return nil }
    guard let t = title, !t.isEmpty else {
        // AX 侧无 title 可比对：纯 frame 唯一匹配（与旧行为一致）。
        return candidates.count == 1 ? candidates[0] : nil
    }
    // CG 侧有可用窗名的候选必须 title 一致；若没有任何候选带可用窗名（kCGWindowName
    // 对某些窗口合法为空 / 无屏幕录制授权），才允许纯 frame 唯一匹配。
    let withUsableName = candidates.filter { $0.name != nil && !$0.name!.isEmpty }
    if withUsableName.isEmpty {
        return candidates.count == 1 ? candidates[0] : nil
    }
    let titled = withUsableName.filter { $0.name == t }
    return titled.count == 1 ? titled[0] : nil
}

// MARK: - reconcile + listWindows（只有 listWindows 签发新 ID）

/// 列窗口。pid=nil 时遍历全部 regular GUI app（与 listApps 同源 NSWorkspace）。
/// reconcile 规则（ADR-1）：读 AXWindows → CFEqual 对齐沿用旧 ID → 新 element 分配新 ID
/// → 完整重列中消失的该 app entry 转 tombstone → cannotComplete 不删句柄（transient hint）。
func listWindowsFull(pid: pid_t?) -> [String: Any] {
    let now = Date()
    purgeTombstones(now: now)

    var targets: [(pid: pid_t, name: String)] = []
    if let pid {
        targets = [(pid, appNameForPid(pid))]
    } else {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isTerminated
        }
        targets = apps
            .sorted { ($0.localizedName ?? "").lowercased() < ($1.localizedName ?? "").lowercased() }
            .map { ($0.processIdentifier, $0.localizedName ?? "pid-\($0.processIdentifier)") }
    }
    let targetPids = Set(targets.map { $0.pid })

    // CGWindowList 整表只读一次；绑定按 pid 过滤后再匹配。
    let cgAll = cgWindowListAll()

    var outWindows: [[String: Any]] = []
    var transientApps: [String] = []

    for (tpid, tname) in targets {
        let axApp = AXUIElementCreateApplication(tpid)
        guard let windows = axAttrArray(axApp, kAXWindowsAttribute as String) else {
            var unused: CFTypeRef?
            let code = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &unused)
            if code == .cannotComplete {
                // 暂时不可响应 ≠ 窗口消失：句柄全部保留（ADR-1 规则 5），如实回报 transient。
                transientApps.append(tname)
            }
            // 其它读失败（未授权/无 AX 树/刚退出）：无从对齐，保守不 tombstone 该 app 的句柄。
            continue
        }

        // CFEqual 对齐：命中沿用旧 entry 并刷新缓存；未命中分配新 ID。
        var fresh: [WindowEntry] = []
        var usedIds = Set<String>()
        for w in windows {
            var existing: WindowEntry? = nil
            for (wid, e) in gRegistry.sorted(by: { $0.key < $1.key })
            where e.pid == tpid && !usedIds.contains(wid) {
                if CFEqual(e.element, w) { existing = e; break }
            }
            if let e = existing {
                usedIds.insert(e.windowId)
                e.refresh()
                fresh.append(e)
            } else {
                let e = WindowEntry(windowId: newWindowId(), pid: tpid, element: w)
                e.refresh()
                gRegistry[e.windowId] = e
                usedIds.insert(e.windowId)
                fresh.append(e)
            }
        }
        // 完整重列消失的该 app entry → tombstone（先收集再删，避免遍历中变更字典）。
        let goneIds = gRegistry.filter { $0.value.pid == tpid && !usedIds.contains($0.key) }.map { $0.key }
        for wid in goneIds {
            if let e = gRegistry.removeValue(forKey: wid) { bury(e, now: now) }
        }

        // 截图绑定：pid+layer==0 过滤后 frame+title 匹配；唯一命中才绑（captureAvailable）。
        let cgForPid = cgAll.filter { $0.pid == tpid }
        for e in fresh {
            if let hit = matchCGWindow(title: e.title, frame: e.frame, in: cgForPid) {
                e.cgWindowNumber = hit.number
                e.captureAvailable = true
            } else {
                e.cgWindowNumber = nil
                e.captureAvailable = false
            }
            outWindows.append(e.summary(appName: tname))
        }
    }

    // 全量重列模式：app 已不在运行列表 → 其全部 entry 转 tombstone（app 退出可靠证据）。
    if pid == nil {
        let deadIds = gRegistry.filter { !targetPids.contains($0.value.pid) }.map { $0.key }
        for wid in deadIds {
            if let e = gRegistry.removeValue(forKey: wid) { bury(e, now: now) }
        }
    }

    var out: [String: Any] = ["windows": outWindows]
    if !transientApps.isEmpty {
        out["hint"] = "以下 app 暂未响应 AX 请求（transient，既有句柄保留）: " +
            transientApps.joined(separator: "、")
    }
    return out
}

// MARK: - 句柄解析（ADR-3 Pull 探活：nonce → registry/tombstone → pid 活 → AX 轻读）

enum WindowResolution {
    case ok(WindowEntry)
    case failure(message: String, code: String, retryable: Bool, recovery: String)
}

/// handle 内部的句柄解析结果：entry 或已折好的错误信封（Dictionary 不满足 Result 的
/// Error 约束，自定义枚举承载）。
enum HandleOutcome {
    case entry(WindowEntry)
    case envelope([String: Any])
}

/// snapshot / windowAction / click(ref) / type(ref) / resolveCapture 共享的句柄解析。
/// 顺序：nonce 校验 → active/tombstone → pid 存活 → AX 轻量属性读探活。
func resolveWindowEntry(_ windowId: String) -> WindowResolution {
    let noncePrefix = "win_\(INSTANCE_NONCE)_"
    guard windowId.hasPrefix(noncePrefix) else {
        if windowId.hasPrefix("win_") {
            return .failure(
                message: "windowId \(windowId) 来自已重启的 driver 会话（旧 nonce，句柄跨进程无效）",
                code: "WINDOW_SESSION_EXPIRED", retryable: false,
                recovery: "computer_windows 重新获取句柄")
        }
        return .failure(
            message: "windowId 格式非法: \(windowId)（应为 win_<nonce>_<seq>，来自 computer_windows）",
            code: "WINDOW_UNKNOWN", retryable: false,
            recovery: "computer_windows 重新获取句柄")
    }
    guard let entry = gRegistry[windowId] else {
        if isTombstoned(windowId) {
            return .failure(
                message: "windowId \(windowId) 对应的窗口已关闭（tombstone）",
                code: "WINDOW_GONE", retryable: false,
                recovery: "computer_windows 重新获取句柄")
        }
        return .failure(
            message: "windowId \(windowId) 不在本进程 registry（未知句柄）",
            code: "WINDOW_UNKNOWN", retryable: false,
            recovery: "computer_windows 重新获取句柄")
    }
    guard NSRunningApplication(processIdentifier: entry.pid) != nil else {
        bury(entry)
        return .failure(
            message: "窗口的 app pid=\(entry.pid) 已退出",
            code: "WINDOW_GONE", retryable: false,
            recovery: "computer_windows 重新获取句柄（必要时先 computer_app launch）")
    }
    // 轻量 AX 探活：invalidUIElement = 窗口已死（tombstone + 释放）；cannotComplete = 暂时
    // 不可响应（保留句柄、可重试）；其它错误只是能力缺失，不是窗口死亡（ADR-3）。
    var probe: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(entry.element, kAXRoleAttribute as CFString, &probe)
    switch code {
    case .success:
        break
    case .invalidUIElement:
        bury(entry)
        return .failure(
            message: "windowId \(windowId) 的 AX 元素已失效（窗口关闭/换窗代理）",
            code: "WINDOW_GONE", retryable: false,
            recovery: "computer_windows 重新获取句柄")
    case .cannotComplete:
        return .failure(
            message: "窗口 app pid=\(entry.pid) 暂未响应 AX 请求（cannotComplete）",
            code: "WINDOW_TRANSIENT", retryable: true,
            recovery: "稍等重试同一 windowId；持续失败再 computer_windows 重列")
    default:
        break
    }
    entry.lastSeenAt = Date()
    return .ok(entry)
}

/// Tier 2 纪律（ADR-4）：带 windowId 的全局事件必须确认目标是全局前台——
/// 该窗口是 app 的 main 窗口且 app 正是 frontmost，否则拒绝。nil = 通过。
func frontmostFailureIfAny(_ entry: WindowEntry) -> (message: String, code: String, retryable: Bool, recovery: String)? {
    let isMain = axAttrBool(entry.element, kAXMainAttribute as String) == true
    let appFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == entry.pid
    if isMain && appFront { return nil }
    return (
        message: "windowId \(entry.windowId) 当前不是全局前台窗口（main=\(isMain), app frontmost=\(appFront)）",
        code: "INPUT_TARGET_NOT_FOCUSED", retryable: false,
        recovery: "computer_window activate 后重试，或省略 windowId 直接全局投递")
}

/// 动作期 AX 错误统一映射（QA FIX-3）：pre-action 探活通过后，真实 AX 操作仍可能失败——
/// 语义必须与探活一致（ADR-3），绝不能落成含糊的 generic FAILED：
///   - invalidUIElement → 窗口已死：tombstone（bury + 释放 AX 引用）+ WINDOW_GONE（不可重试）；
///   - cannotComplete → 暂时不可响应：WINDOW_TRANSIENT 可重试，**绝不删句柄**；
///   - actionUnsupported / attributeUnsupported → 能力缺失不是死亡：报 unsupportedCode
///     （INPUT_UNSUPPORTED / WINDOW_ACTION_UNSUPPORTED），句柄保留；
///   - 其它 → genericCode（AX_ACTION_FAILED / WINDOW_ACTION_FAILED），句柄保留。
/// 返回 nil 表示 code == .success（调用方无需失败信封）。
func mapWindowAXError(_ entry: WindowEntry, _ code: AXError, op: String, detail: String,
                      unsupportedCode: String, genericCode: String) ->
                     (message: String, code: String, retryable: Bool, recovery: String)? {
    switch code {
    case .success:
        return nil
    case .invalidUIElement:
        bury(entry)
        return (
            message: "\(detail): windowId \(entry.windowId) 的 AX 元素已失效（窗口关闭/换窗代理，invalidUIElement）",
            code: "WINDOW_GONE", retryable: false,
            recovery: "computer_windows 重新获取句柄")
    case .cannotComplete:
        return (
            message: "\(detail): app pid=\(entry.pid) 暂未响应 AX 请求（cannotComplete）",
            code: "WINDOW_TRANSIENT", retryable: true,
            recovery: "稍等重试同一 windowId；持续失败再 computer_windows 重列")
    case .actionUnsupported, .attributeUnsupported:
        let recovery = unsupportedCode == "INPUT_UNSUPPORTED"
            ? "可改 x/y 坐标兜底（Tier 2 全局事件，会动真实光标）；或重新 computer_snapshot 找可操作元素"
            : "该窗口类型不支持此动作；改用键击/菜单路径等替代方式"
        return (
            message: "\(detail): \(axErrorText(code, op: op))",
            code: unsupportedCode, retryable: false, recovery: recovery)
    default:
        return (
            message: "\(detail): \(axErrorText(code, op: op))",
            code: genericCode, retryable: false,
            recovery: "重试或重新 computer_snapshot 后再试")
    }
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
    // 可执行动作列表（AXPress 等动作的寻址依据）。
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
    if truncated > 0 { out["truncatedNodes"] = truncated }
    return out
}

// MARK: - 动作原语

/// A5+F2：严格 ref 路径解析（"@0/2/1" → [0,2,1]）。必须以 "@" 开头（快照签发的 ref 形式）；
/// 每个 "/" 段必须是非负整数，不允许空段/负数/非数字；任何畸形输入返回 nil（调用方报错）。
func parseRefPath(_ ref: String) -> [Int]? {
    guard ref.hasPrefix("@") else { return nil }
    let body = String(ref.dropFirst())
    guard !body.isEmpty else { return nil }
    var path: [Int] = []
    for segment in body.split(separator: "/", omittingEmptySubsequences: false) {
        guard !segment.isEmpty, let index = Int(segment), index >= 0 else { return nil }
        path.append(index)
    }
    return path
}

/// 沿快照给定的 ref 路径（如 "0/2/1"）从窗口根重新走位到目标元素。
/// 快照与动作自洽：不持有跨调用对象，路径失配（UI 已变）自然报错。
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

/// QA 终轮（computer_app activate 假成功修复）：激活 + 有界 readback 验证。
/// activateApp Bool 为 false、或 ~300ms 内 app 未成为前台 → false（调用方报 ACTIVATE_FAILED）。
func activateAppVerified(pid: pid_t) -> Bool {
    guard activateApp(pid: pid) else { return false }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
    for _ in 0..<5 {
        usleep(60_000)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
    }
    return false
}

/// 窗口关闭按钮：先读 AXCloseButton 属性；缺席时兜底浅层子树（深度≤3）找
/// subrole == AXCloseButtonSubrole（部分 app 只暴露 subrole 不挂标准属性）。
func findCloseButton(_ window: AXUIElement) -> AXUIElement? {
    if let btn = axAttr(window, kAXCloseButtonAttribute as String),
       CFGetTypeID(btn) == AXUIElementGetTypeID() {
        return (btn as! AXUIElement)
    }
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    while !queue.isEmpty {
        let (el, depth) = queue.removeFirst()
        if depth > 3 { continue }
        if let sub = axAttrString(el, kAXSubroleAttribute as String), sub == "AXCloseButtonSubrole" {
            return el
        }
        if let children = axAttrArray(el, kAXChildrenAttribute as String) {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    return nil
}

/// 写 AXPosition（move verb）。
func setAXPosition(_ element: AXUIElement, x: CGFloat, y: CGFloat) -> AXError {
    var p = CGPoint(x: x, y: y)
    guard let v = AXValueCreate(.cgPoint, &p) else { return .attributeUnsupported }
    return AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, v)
}

/// 写 AXSize（resize verb）。
func setAXSize(_ element: AXUIElement, width: CGFloat, height: CGFloat) -> AXError {
    var s = CGSize(width: width, height: height)
    guard let v = AXValueCreate(.cgSize, &s) else { return .attributeUnsupported }
    return AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, v)
}

// MARK: - 键击 / 指针事件（Tier 2 全局 CGEvent；Tier 1 未实现）

/// 键盘符号名 → macOS keycode（Apple ANSI 布局全表：字母/数字/标点 + 功能键/方向键）。
/// 单个可打印字符不必查表——走 unicode 注入路径（layout 无关）；表只服务「组合键里的主键」
/// 和显式按键名（JS 侧 parseKeyCombo 与此表镜像，见 tools.mjs KEY_NAMES）。
let KEY_CODES: [String: UInt16] = [
    // 常用功能键
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    // 字母行（ANSI 物理布局 keycode）
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
    "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
    "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
    "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23,
    "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
    // 数字行
    "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
    "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
    // 标点（shift 变体由调用方加 maskShift，如 plus/minus 别名）
    "=": 0x18, "-": 0x1B, "]": 0x1E, "[": 0x21,
    "'": 0x27, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, ".": 0x2F, "`": 0x32,
    // 语义别名
    "plus": 0x18,  // '=' 键 + shift（见 plan 化的 postKeyPlan）
    "minus": 0x1B,
]

/// 结构化键击计划：JS 侧解析完成后以 plan 下发，driver 只做哑执行（不解析符号名）。
/// - unicode 路径：按字符注入（单字符/文本，layout 无关）。
/// - keyCode 路径：按虚拟 keycode + 原始 CGEventFlags 注入 down/up。
struct KeyPlan {
    var unicode: String? = nil
    var keyCode: UInt16? = nil
    var flags: CGEventFlags = []
    var tapDelayMs: Int = 12
}

/// 执行 KeyPlan：unicode 或 keyCode 二选一（都缺失/都超界 → 抛错，绝不静默猜测）。
func postKeyPlan(_ plan: KeyPlan) throws {
    if let text = plan.unicode {
        try postUnicodeString(text)
        return
    }
    guard let keyCode = plan.keyCode else {
        throw DriverError("key plan 缺少 unicode/keyCode 之一")
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw DriverError("CGEvent 创建失败（keyCode=\(keyCode)）")
    }
    down.flags = plan.flags
    up.flags = plan.flags
    down.post(tap: .cghidEventTap)
    usleep(UInt32(max(0, min(plan.tapDelayMs, 200))) * 1000)
    up.post(tap: .cghidEventTap)
}

/// 从 JSON args 里取结构化 keyPlan（op "key" 的 args.plan）；字段全部严格校验。
func parseKeyPlanJSON(_ raw: Any) -> KeyPlan? {
    guard let dict = raw as? [String: Any] else { return nil }
    var plan = KeyPlan()
    if let uni = dict["unicode"] as? String { plan.unicode = uni }
    if let kc = (dict["keyCode"] as? NSNumber)?.intValue {
        guard kc >= 0, kc <= UInt16.max else { return nil }
        plan.keyCode = UInt16(kc)
    }
    if let f = (dict["flags"] as? NSNumber)?.uint64Value {
        plan.flags = CGEventFlags(rawValue: f)
    }
    if let d = (dict["tapDelayMs"] as? NSNumber)?.intValue {
        plan.tapDelayMs = d
    }
    // 两者皆缺 → 无效计划。
    if plan.unicode == nil && plan.keyCode == nil { return nil }
    return plan
}

/// legacy 组合键解析（严格版）：未知修饰键名 ERROR；多于一个主键 ERROR；
/// 未知主键名 ERROR（绝不退化为把名字当文本注入）；无修饰键的单个可打印字符走 unicode 路径。
/// 新代码请走 args.plan（JS 侧 parseKeyCombo 生成）；本函数只为旧调用面保留。
func postKeyCombo(_ combo: String) throws {
    var flags: CGEventFlags = []
    let keyName = combo.lowercased().trimmingCharacters(in: .whitespaces)
    let modifiers: [(String, CGEventFlags)] = [
        ("cmd", .maskCommand), ("command", .maskCommand),
        ("ctrl", .maskControl), ("control", .maskControl),
        ("alt", .maskAlternate), ("option", .maskAlternate),
        ("shift", .maskShift), ("fn", .maskSecondaryFn),
    ]
    var parts = keyName.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard !parts.isEmpty else {
        throw DriverError("无法解析组合键: \(combo)（期望形如 cmd+shift+t 或 Return）")
    }
    // 逐段剥离修饰键；未知名直接报错（strict，不静默当主键）。
    parts = try parts.filter { part in
        if let m = modifiers.first(where: { $0.0 == part }) {
            flags.insert(m.1)
            return false
        }
        if KEY_CODES[part] == nil && part.count != 1 {
            throw DriverError("未知修饰键或主键: \(part)（combo=\(combo)；支持 cmd/ctrl/alt/option/shift/fn + 按键名）")
        }
        return true
    }
    guard parts.count == 1, !parts[0].isEmpty else {
        throw DriverError("组合键主键必须恰好一个: \(combo)（期望形如 cmd+shift+t 或 Return）")
    }
    let name = parts[0]
    var plan = KeyPlan()
    plan.flags = flags
    if let known = KEY_CODES[name] {
        plan.keyCode = known
        // plus 别名 = '=' 键，物理上需要 shift（minus 不需要）。
        if name == "plus" { plan.flags.insert(.maskShift) }
    } else if name.count == 1,
              parts.count == 1, flags.isEmpty,
              let scalar = name.unicodeScalars.first,
              !scalar.properties.isDefaultIgnorableCodePoint {
        // 无修饰键的单字符：unicode 注入路径（layout 无关）。带修饰键的单字符必须查表命中，
        // 否则修饰键会丢——上面已对未知名报错，不会走到这。
        plan.unicode = name
    } else {
        throw DriverError("未知按键名: \(name)（combo=\(combo)；带修饰键的字符需查表命中，请用 keyCode plan）")
    }
    try postKeyPlan(plan)
}

/// F1：把 UTF-16 单元切成每批 ≤maxLen 个的事件批次，且批次边界绝不落在代理对中间
/// （高代理 0xD800-0xDBFF 必须与其低代理 0xDC00-0xDFFF 同批——keyboardSetUnicodeString
/// 收到被拆开的代理对会注入错字）。纯函数，便于人工推理与回归。
func utf16Batches(_ units: [UInt16], maxLen: Int = 20) -> [[UInt16]] {
    precondition(maxLen >= 1, "maxLen 必须为正")
    var batches: [[UInt16]] = []
    var offset = 0
    while offset < units.count {
        var end = min(offset + maxLen, units.count)
        if end < units.count,
           (0xD800...0xDBFF).contains(units[end - 1]),
           (0xDC00...0xDFFF).contains(units[end]) {
            // 边界切在代理对中间：挪走高代理；若批次只装得下这一个单元，则扩容带上低代理。
            end = (end - 1 > offset) ? end - 1 : end + 1
        }
        batches.append(Array(units[offset..<end]))
        offset = end
    }
    return batches
}

/// QA 终轮：Tier 2 CGEvent 投递的权限门槛——post() 无返回值，权限缺失时事件被系统
/// 静默丢弃，调用方却拿到 posted-unverified「成功」。preflight false → 拒绝投递。
/// 返回 nil = 放行；返回字典 = 已成的失败应答（INPUT_POST_ACCESS_DENIED）。
func postEventGate(_ id: Int) -> [String: Any]? {
    // 测试钩子：POST_EVENT_DENIED_FOR_TEST=1 时强制按「权限缺失」路径构造应答——
    // 用于回归测试验证信封 id 与请求 id 正确配对（session 层按 id 路由，id 错 = 应答被丢）。
    // 生产环境不设该变量，走真实 preflight。
    let forcedDenied = ProcessInfo.processInfo.environment["POST_EVENT_DENIED_FOR_TEST"] == "1"
    if !forcedDenied, CGPreflightPostEventAccess() { return nil }
    return ["id": id, "ok": false, "error": "当前进程缺少事件注入权限（CGPreflightPostEventAccess=false）——Tier 2 全局事件会被系统静默丢弃",
            "code": "INPUT_POST_ACCESS_DENIED", "retryable": false,
            "recovery": "系统设置 → 隐私与安全性 → 辅助功能：把运行 DSH 的条目加进去（见 computer_doctor 指引）"]
}

/// 按字符注入任意文本（unicode 串），不走 keycode。
/// A3：按 UTF-16 code unit 迭代（text.utf16），代理对（emoji / 扩展 CJK）成对保留——
/// unicodeScalars 会把代理对拆开，keyboardSetUnicodeString 收到孤立代理会注入错字。
/// F1：事件批次由 utf16Batches 切分（≤20 单元且不拆代理对）；事件间 6ms 延迟沿用实测值。
func postUnicodeString(_ text: String) throws {
    for batch in utf16Batches(Array(text.utf16)) {
        var chars = [UniChar](batch)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw DriverError("CGEvent 创建失败（unicode 注入）")
        }
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        down.post(tap: .cghidEventTap)
        usleep(6_000)
        up.post(tap: .cghidEventTap)
    }
}

struct DriverError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// 坐标点击（CGEvent，Tier 2 全局事件，占用真实光标）：先移鼠标再按下/抬起。
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
        // AXMenu role 的子元素下（点开后才挂上），从它拿菜单项；没有则用 element 自身 children。
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
    /// 错误信封（v0.2.0）：code/retryable/recovery 是稳定字段，Node 侧折进 Error 前缀供模型自愈。
    func fail(_ message: String, code: String, retryable: Bool, recovery: String) -> [String: Any] {
        ["id": id, "ok": false, "error": message, "code": code, "retryable": retryable, "recovery": recovery]
    }
    /// 用法类错误的统一信封（缺参/非法参数值）。
    func usageFail(_ message: String, recovery: String = "按错误信息修正参数后重试") -> [String: Any] {
        fail(message, code: "INVALID_ARGUMENT", retryable: false, recovery: recovery)
    }
    /// 句柄解析（幂等读）：entry 或已折好的错误信封（[String:Any] 不满足 Result.Error
    /// 约束，用自定义枚举；探活副作用只发生一次）。
    func resolveOr(_ windowId: String) -> HandleOutcome {
        switch resolveWindowEntry(windowId) {
        case .ok(let entry): return .entry(entry)
        case .failure(let m, let c, let r, let rec):
            return .envelope(fail(m, code: c, retryable: r, recovery: rec))
        }
    }
    /// 统一入口：解析句柄（可选前台纪律）后执行 body；任何失败直接返回错误信封。
    func withEntry(_ windowId: String, requireFrontmost: Bool = false,
                   _ body: (WindowEntry) -> [String: Any]) -> [String: Any] {
        switch resolveOr(windowId) {
        case .envelope(let envelope): return envelope
        case .entry(let entry):
            if requireFrontmost, let f = frontmostFailureIfAny(entry) {
                return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
            }
            return body(entry)
        }
    }
    /// QA FIX-3：动作期 AX 错误统一走 mapWindowAXError 折成错误信封（code==.success 不断言，
    /// 调用方先自行 guard success）。
    func failMapped(_ entry: WindowEntry, _ code: AXError, op: String, detail: String,
                    unsupportedCode: String, genericCode: String) -> [String: Any] {
        let f = mapWindowAXError(entry, code, op: op, detail: detail,
                                 unsupportedCode: unsupportedCode, genericCode: genericCode)
        return fail(f?.message ?? "success", code: f?.code ?? "AX_ACTION_FAILED",
                    retryable: f?.retryable ?? false, recovery: f?.recovery ?? "重试")
    }
    /// QA FIX-6：CGEvent 投递失败的稳定错误码。创建阶段返回 nil（DriverError 文本带
    /// 「CGEvent 创建失败」）多为事件投递授权缺席（plausibly permissions）→
    /// INPUT_POST_ACCESS_DENIED；其余失败仍 INPUT_POST_FAILED。两码都记入 README 错误表。
    func inputPostFail(_ error: Error, recovery: String) -> [String: Any] {
        let text = String(describing: error)
        let denied = text.contains("CGEvent 创建失败")
        return fail(text, code: denied ? "INPUT_POST_ACCESS_DENIED" : "INPUT_POST_FAILED",
                    retryable: false,
                    recovery: denied
                        ? "调用 computer_doctor 复查辅助功能/事件投递授权（postEventAccess）"
                        : recovery)
    }

    switch op {
    case "ping":
        return reply([
            "pong": true,
            "trusted": AXIsProcessTrusted(),
            "nonce": INSTANCE_NONCE,
            "sdk": ProcessInfo.processInfo.operatingSystemVersionString,
        ])
    case "doctor":
        // 权限事实上报（判定在 Node 侧）：辅助功能授权与否、AX 是否可用、屏幕录制预检。
        var out: [String: Any] = [
            "axTrusted": AXIsProcessTrusted(),
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
            // A8：屏幕录制授权预检（CGPreflightScreenCaptureAccess，只查不弹窗）。
            "screenCapture": CGPreflightScreenCaptureAccess(),
            // QA FIX-6：事件投递权限预检（CGPreflightPostEventAccess，只查不弹窗）——
            // Tier 2 CGEvent 注入的前置条件；INPUT_POST_ACCESS_DENIED 的判定依据之一。
            "postEventAccess": CGPreflightPostEventAccess(),
        ]
        if let front = NSWorkspace.shared.frontmostApplication {
            out["frontApp"] = ["pid": front.processIdentifier, "name": front.localizedName ?? ""]
        }
        return reply(out)
    case "listApps":
        return reply(["apps": listApps()])

    case "listWindows":
        // v0.2.0：pid 可选（省略 = 全部 GUI app 的窗口）；返回项带 windowId 签发/沿用结果。
        let args = request["args"] as? [String: Any] ?? [:]
        let pid = (args["pid"] as? NSNumber)?.intValue
        if let pid, pid <= 0 {
            return usageFail("pid 必须是正整数（来自 computer_list_apps），或省略以列全部窗口")
        }
        return reply(listWindowsFull(pid: pid == nil ? nil : pid_t(pid!)))

    case "snapshot":
        guard let args = request["args"] as? [String: Any],
              let windowId = args["windowId"] as? String else {
            return usageFail("snapshot 需要 args.windowId（来自 computer_windows）",
                             recovery: "computer_windows 获取句柄")
        }
        let maxDepth = (args["maxDepth"] as? NSNumber)?.intValue ?? 18
        let maxNodes = (args["maxNodes"] as? NSNumber)?.intValue ?? 800
        return withEntry(windowId) { entry in
            var out = snapshotWindow(entry.element, maxDepth: maxDepth, maxNodes: maxNodes)
            // 刷新缓存 title/frame（snapshotWindow 已读，这里同步进 registry 缓存）。
            if let t = out["title"] as? String { entry.title = t }
            if let f = out["frame"] as? [String: Any] { entry.frame = f }
            entry.lastSeenAt = Date()
            out["windowId"] = entry.windowId
            out["pid"] = Int(entry.pid)
            return reply(out)
        }

    // ---- 窗口操作 op（v0.2.0 新增：computer_window 单工具）----

    case "windowAction":
        guard let args = request["args"] as? [String: Any],
              let windowId = args["windowId"] as? String,
              let verb = args["verb"] as? String else {
            return usageFail("windowAction 需要 args.windowId + args.verb")
        }
        let resolution = resolveOr(windowId)
        guard case .entry(let entry) = resolution else {
            if case .envelope(let envelope) = resolution { return envelope }
            return usageFail("windowAction 句柄解析异常", recovery: "computer_windows 重新获取句柄")
        }
        let el = entry.element
        switch verb {
        case "activate":
            // AXRaise + 激活 app（抢全局焦点；不做单独 focus verb——AXMain≠全局键盘焦点）。
            let code = performAction(el, kAXRaiseAction as String)
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "AXRaise 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
            // QA FIX-4：activate 不再「发了就算」——activateApp 的 Bool 与随后 app 是否真到
            // 前台都要核实；失败/未到位如实报 ACTIVATE_FAILED（可重试），不假装 ok。
            guard activateApp(pid: entry.pid) else {
                return fail("activate 失败：app pid=\(entry.pid) 不可激活（已退出或后台限定）",
                            code: "ACTIVATE_FAILED", retryable: true,
                            recovery: "computer_list_apps 确认 pid 存活；或 computer_app activate")
            }
            // 有界等待（≤~300ms，5×60ms 轮询）：激活是异步的，立刻读 frontmost 常误判。
            var becameFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == entry.pid
            if !becameFront {
                for _ in 0..<5 {
                    usleep(60_000)
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier == entry.pid {
                        becameFront = true
                        break
                    }
                }
            }
            guard becameFront else {
                return fail("AXRaise+activate 已执行但 pid=\(entry.pid) 未在预算内（~300ms）成为前台 app",
                            code: "ACTIVATE_FAILED", retryable: true,
                            recovery: "computer_app activate 后重试；必要时先检查 app 是否弹窗阻塞激活")
            }
        case "raise":
            let code = performAction(el, kAXRaiseAction as String)
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "AXRaise 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
        case "close":
            // 「发出关闭请求」语义：保存框可能让窗继续存在（如实返回，不假装窗口必关）。
            guard let button = findCloseButton(el) else {
                return fail("窗口没有可寻址的关闭按钮（AXCloseButton 缺席且 subrole 搜索未命中）",
                            code: "WINDOW_ACTION_UNSUPPORTED", retryable: false,
                            recovery: "用 computer_key cmd+w 或菜单路径关闭")
            }
            let code = performAction(button, kAXPressAction as String)
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "关闭按钮 AXPress 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
        case "minimize", "restore":
            let target = verb == "minimize"
            let code = AXUIElementSetAttributeValue(el, kAXMinimizedAttribute as CFString,
                                                    target ? kCFBooleanTrue : kCFBooleanFalse)
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "set AXMinimized 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
            // 读回验证：set 成功 ≠ 状态落地，不假装成功（ADR-2 verb 定义）。
            usleep(60_000)
            let actual = axAttrBool(el, kAXMinimizedAttribute as String)
            guard actual == target else {
                return fail("set AXMinimized 后读回不符（期望 \(target)，实际 \(actual.map(String.init) ?? "nil")）",
                            code: "WINDOW_ACTION_FAILED", retryable: false,
                            recovery: "重新 computer_windows 观察实际状态")
            }
        case "move":
            guard let x = (args["x"] as? NSNumber)?.doubleValue,
                  let y = (args["y"] as? NSNumber)?.doubleValue else {
                return usageFail("verb=move 需要 args.x/args.y（屏幕逻辑点）")
            }
            let code = setAXPosition(el, x: CGFloat(x), y: CGFloat(y))
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "set AXPosition 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
        case "resize":
            guard let w = (args["width"] as? NSNumber)?.doubleValue,
                  let h = (args["height"] as? NSNumber)?.doubleValue else {
                return usageFail("verb=resize 需要 args.width/args.height（逻辑点）")
            }
            let code = setAXSize(el, width: CGFloat(w), height: CGFloat(h))
            guard code == .success else {
                return failMapped(entry, code, op: "windowAction", detail: "set AXSize 失败",
                                  unsupportedCode: "WINDOW_ACTION_UNSUPPORTED",
                                  genericCode: "WINDOW_ACTION_FAILED")
            }
        default:
            return usageFail("未知 verb: \(verb)（支持 activate/raise/close/minimize/restore/move/resize）")
        }
        // 成功：刷新缓存并带 post-state 条件性返回。
        entry.refresh()
        var out: [String: Any] = ["windowId": entry.windowId, "verb": verb, "ok": true]
        if let t = entry.title, !t.isEmpty { out["title"] = t }
        if let f = entry.frame { out["frame"] = f }
        if let m = entry.minimized { out["minimized"] = m }
        return reply(out)

    // ---- 截图绑定解析 op（v0.2-C：resolveCapture 重核 pid/title/frame）----

    case "resolveCapture":
        guard let args = request["args"] as? [String: Any],
              let windowId = args["windowId"] as? String else {
            return usageFail("resolveCapture 需要 args.windowId（来自 computer_windows）",
                             recovery: "computer_windows 获取句柄")
        }
        let resolution = resolveOr(windowId)
        guard case .entry(let entry) = resolution else {
            if case .envelope(let envelope) = resolution { return envelope }
            return usageFail("resolveCapture 句柄解析异常", recovery: "computer_windows 重新获取句柄")
        }
        // QA 终轮错绑修复：绑定键（title/frame）必须新鲜且读取成功——refreshStrict 三态，
        // 失败 fail-closed，绝不沿用可能已被同 pid 其他窗口占据的缓存 title/frame 匹配。
        switch entry.refreshStrict() {
        case .gone:
            bury(entry)
            return fail("窗口已关闭（AX 探活 invalidUIElement）",
                        code: "WINDOW_GONE", retryable: false, recovery: "computer_windows 重新获取句柄")
        case .transient:
            return fail("窗口暂时不可响应 AX 读取（cannotComplete），拒绝用缓存 title/frame 匹配截图",
                        code: "WINDOW_TRANSIENT", retryable: true,
                        recovery: "稍后重试；必要时 computer_windows 重列")
        case .ok: break
        }
        if entry.minimized == true {
            return fail("窗口已最小化，无 on-screen CG 记录可截",
                        code: "WINDOW_NOT_CAPTURABLE", retryable: false,
                        recovery: "computer_window restore + activate 后重试")
        }
        let cgForPid = cgWindowListAll().filter { $0.pid == entry.pid }
        if let hit = matchCGWindow(title: entry.title, frame: entry.frame, in: cgForPid) {
            // 绑定可能相对 listWindows 时已变（CGWindowNumber 被系统重排）——以重核结果为准。
            entry.cgWindowNumber = hit.number
            entry.captureAvailable = true
            return reply(["windowId": entry.windowId, "cgWindowNumber": hit.number])
        }
        let frameCandidates = cgForPid.filter { framesMatch(entry.frame, $0.frame) }
        if frameCandidates.count > 1 {
            return fail("窗口截图绑定歧义：pid=\(entry.pid) 有 \(frameCandidates.count) 个 frame 相符的 on-screen CG 窗口（同题同尺寸重叠）",
                        code: "WINDOW_CAPTURE_AMBIGUOUS", retryable: false,
                        recovery: "computer_window activate 提到前台后重试；或 mode=all 截全屏")
        }
        return fail("窗口没有可匹配的 on-screen CG 记录（title/frame 与 CGWindowList 不符，或被隐藏）",
                    code: "WINDOW_NOT_CAPTURABLE", retryable: false,
                    recovery: "computer_windows 重列确认窗口状态；必要时 activate 后重试")

    // ---- 输入 op（v0.2.0：windowId-first + mode/delivery 统一输出）----

    case "click":
        guard let args = request["args"] as? [String: Any] else {
            return usageFail("click 需要 args")
        }
        let action = (args["action"] as? String) ?? "AXPress"
        // inputMode 随请求透传（QA FIX-1a：与 type/key/scroll 统一；driver 侧 click ref 分支
        // 本就是 Tier 0，cursorless 合法；fallback 纪律只在 type 的 set 失败路径生效）。
        let inputMode = (args["inputMode"] as? String) ?? "auto"
        // ref 寻址（Tier 0）：必须带 windowId——从 registry 拿 retained 窗口元素再走 ref 路径。
        // F2 纪律保留：提供了 ref（任意字符串）就走 ref 分支严格校验，绝不静默落坐标。
        if let ref = args["ref"] as? String {
            guard let windowId = args["windowId"] as? String else {
                return usageFail("ref 模式必须提供 windowId（v0.2.0 起窗口身份是 computer_windows 签发的句柄）",
                                 recovery: "computer_windows 获取句柄后携带 windowId 重试")
            }
            let resolution = resolveOr(windowId)
            guard case .entry(let entry) = resolution else {
                if case .envelope(let envelope) = resolution { return envelope }
                return usageFail("click 句柄解析异常", recovery: "computer_windows 重新获取句柄")
            }
            guard let path = parseRefPath(ref) else {
                return usageFail("ref 格式非法: \(ref)（应为 @0/2/1 形式，重新 computer_snapshot）")
            }
            guard let element = resolveByPath(entry.element, path) else {
                return usageFail("ref \(ref) 解析失败（UI 已变化？重新 computer_snapshot）")
            }
            let code = performAction(element, action)
            guard code == .success else {
                // QA FIX-3：动作期 AX 错误统一映射——invalidUIElement → WINDOW_GONE（tombstone）、
                // cannotComplete → WINDOW_TRANSIENT（绝不自动 fallback：动作可能已执行，
                // 重发=双击，ADR-4）、actionUnsupported → INPUT_UNSUPPORTED，其余 generic。
                return failMapped(entry, code, op: "click", detail: "AX 动作 \(action) 失败（inputMode=\(inputMode)）",
                                  unsupportedCode: "INPUT_UNSUPPORTED", genericCode: "AX_ACTION_FAILED")
            }
            entry.refresh()
            var out: [String: Any] = [
                "mode": "ax-action", "delivery": "acknowledged",
                "windowId": entry.windowId, "ref": ref, "action": action,
            ]
            if let f = entry.frame { out["frame"] = f }
            return reply(out)
        }
        // 坐标点击（Tier 2 全局事件）：windowId 给定则执行前台纪律。
        if let x = (args["x"] as? NSNumber)?.doubleValue,
           let y = (args["y"] as? NSNumber)?.doubleValue {
            var entry: WindowEntry? = nil
            if let windowId = args["windowId"] as? String {
                let resolution = resolveOr(windowId)
                guard case .entry(let e) = resolution else {
                    if case .envelope(let envelope) = resolution { return envelope }
                    return usageFail("click 句柄解析异常", recovery: "computer_windows 重新获取句柄")
                }
                if let f = frontmostFailureIfAny(e) {
                    return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
                }
                entry = e
            }
            guard x.isFinite, y.isFinite else {
                return usageFail("click 的 x/y 必须是有限数字: x=\(x) y=\(y)")
            }
            do {
                // QA 终轮：Tier 2 权限门槛。
                if let gate = postEventGate(id.intValue) { return gate }
                try postClick(x: CGFloat(x), y: CGFloat(y))
                var out: [String: Any] = [
                    "mode": "global-cgevent", "delivery": "posted-unverified", "x": x, "y": y,
                ]
                if let e = entry { out["windowId"] = e.windowId }
                return reply(out)
            } catch {
                // QA FIX-6：创建失败（多为事件投递授权缺席）→ INPUT_POST_ACCESS_DENIED。
                return inputPostFail(error, recovery: "检查坐标是否在屏幕范围内后重试")
            }
        }
        return usageFail("click 需要 args.ref（来自 computer_snapshot，配合 windowId）或 args.x/args.y")

    case "type":
        guard let args = request["args"] as? [String: Any],
              let text = args["text"] as? String else {
            return usageFail("type 需要 args.text")
        }
        let inputMode = (args["inputMode"] as? String) ?? "auto"
        // ref 寻址（Tier 0）：windowId 必填；set value 成功 = ax-value/acknowledged。
        // set 失败的 fallback 纪律（QA FIX-1b，ADR-4）：
        //   ① cannotComplete / invalidUIElement → 按 mapWindowAXError 报 WINDOW_TRANSIENT /
        //      WINDOW_GONE，**绝不落入全局注入**（动作可能已生效/窗口已死）；
        //   ② inputMode=cursorless → INPUT_UNSUPPORTED，绝不退全局 CGEvent（Tier 1 未实现，
        //      不静默降级）；
        //   ③ auto / global → 可退「聚焦 + unicode 注入」（Tier 2），但必须先过与 Tier-2
        //      windowId 操作相同的前台纪律（app frontmost 且窗口 main），否则
        //      INPUT_TARGET_NOT_FOCUSED；fallback 应答 mode=global-cgevent /
        //      delivery=posted-unverified（与 set 成功的 ax-value/acknowledged 如实区分）。
        if let ref = args["ref"] as? String {
            guard let windowId = args["windowId"] as? String else {
                return usageFail("ref 模式必须提供 windowId（v0.2.0 起窗口身份是 computer_windows 签发的句柄）",
                                 recovery: "computer_windows 获取句柄后携带 windowId 重试")
            }
            let resolution = resolveOr(windowId)
            guard case .entry(let entry) = resolution else {
                if case .envelope(let envelope) = resolution { return envelope }
                return usageFail("type 句柄解析异常", recovery: "computer_windows 重新获取句柄")
            }
            guard let path = parseRefPath(ref) else {
                return usageFail("ref 格式非法: \(ref)（应为 @0/2/1 形式，重新 computer_snapshot）")
            }
            guard let element = resolveByPath(entry.element, path) else {
                return usageFail("ref \(ref) 解析失败（UI 已变化？重新 computer_snapshot）")
            }
            let setCode = setElementValue(element, text)
            if setCode == .success {
                return reply(["mode": "ax-value", "delivery": "acknowledged",
                              "windowId": entry.windowId, "ref": ref, "length": text.count])
            }
            // ① cannotComplete / invalidUIElement：统一映射，绝不 fallback。
            if setCode == .cannotComplete || setCode == .invalidUIElement {
                return failMapped(entry, setCode, op: "type", detail: "set value 失败",
                                  unsupportedCode: "INPUT_UNSUPPORTED", genericCode: "AX_ACTION_FAILED")
            }
            // ② cursorless：明确拒绝 Tier 2 退路。
            if inputMode == "cursorless" {
                return fail("set value 失败（\(axErrorText(setCode, op: "type"))）且 inputMode=cursorless " +
                            "禁止退回 Tier 2 全局事件注入（Tier 1 未实现，绝不静默降级）",
                            code: "INPUT_UNSUPPORTED", retryable: false,
                            recovery: "改用可 set value 的元素（AXTextArea/AXTextField），或去掉 inputMode " +
                                      "允许前台聚焦注入")
            }
            // ③ auto/global：QA 终轮修正顺序——前台纪律必须在任何 AX 状态写操作之前。
            // （旧实现先 AXFocused=true 再查前台：后台窗口会先被改焦点状态，违反
            // 「窗口非前台时绝不触碰」的安全契约。）
            if let f = frontmostFailureIfAny(entry) {
                return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
            }
            let focusCode = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard focusCode == .success else {
                return failMapped(entry, focusCode, op: "type",
                                  detail: "set value 失败（\(axErrorText(setCode, op: "type"))）；聚焦目标元素也失败",
                                  unsupportedCode: "INPUT_UNSUPPORTED", genericCode: "AX_ACTION_FAILED")
            }
            // QA 终轮：Tier 2 权限门槛——preflight false 时绝不投递（post() 静默丢弃会伪装成功）。
            if let gate = postEventGate(id.intValue) { return gate }
            do {
                try postUnicodeString(text)
                return reply(["mode": "global-cgevent", "delivery": "posted-unverified",
                              "windowId": entry.windowId, "ref": ref, "length": text.count])
            } catch {
                // QA FIX-6：创建失败 → INPUT_POST_ACCESS_DENIED。
                return inputPostFail(error, recovery: "确认目标 app 在前台后重试")
            }
        } else if let windowId = args["windowId"] as? String {
            // 无 ref 焦点注入是 Tier 2：带 windowId 则执行前台纪律。
            let resolution = resolveOr(windowId)
            guard case .entry(let entry) = resolution else {
                if case .envelope(let envelope) = resolution { return envelope }
                return usageFail("type 句柄解析异常", recovery: "computer_windows 重新获取句柄")
            }
            if let f = frontmostFailureIfAny(entry) {
                return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
            }
        }
        // QA 终轮：Tier 2 权限门槛——preflight false 时绝不投递（post() 静默丢弃会伪装成功）。
        if let gate = postEventGate(id.intValue) { return gate }
        do {
            try postUnicodeString(text)
            return reply(["mode": "global-cgevent", "delivery": "posted-unverified",
                          "length": text.count])
        } catch {
            // QA FIX-6：创建失败 → INPUT_POST_ACCESS_DENIED。
            return inputPostFail(error, recovery: "确认目标 app 在前台后重试")
        }

    case "key":
        guard let args = request["args"] as? [String: Any] else {
            return usageFail("key 需要 args（combo 或 plan）")
        }
        // key 是 Tier 2 全局事件；带 windowId 则执行前台纪律。
        if let windowId = args["windowId"] as? String {
            let resolution = resolveOr(windowId)
            guard case .entry(let entry) = resolution else {
                if case .envelope(let envelope) = resolution { return envelope }
                return usageFail("key 句柄解析异常", recovery: "computer_windows 重新获取句柄")
            }
            if let f = frontmostFailureIfAny(entry) {
                return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
            }
        }
        do {
            // QA 终轮：Tier 2 权限门槛（key 同 type/scroll）。
            if let gate = postEventGate(id.intValue) { return gate }
            // A2：结构化 plan 优先（JS 侧 parseKeyCombo 解析后哑执行）；
            // 无 plan 再走 legacy combo（严格解析：未知键名报错，绝不退化为文本注入）。
            if let raw = args["plan"], let plan = parseKeyPlanJSON(raw) {
                try postKeyPlan(plan)
                let comboEcho = (args["combo"] as? String) ?? ""
                return reply(["combo": comboEcho, "planned": true,
                              "mode": "global-cgevent", "delivery": "posted-unverified"])
            }
            guard let combo = args["combo"] as? String, !combo.isEmpty else {
                return usageFail("key 需要 args.combo（如 return / cmd+shift+t / ctrl+a）或 args.plan")
            }
            try postKeyCombo(combo)
            return reply(["combo": combo, "mode": "global-cgevent", "delivery": "posted-unverified"])
        } catch {
            // QA FIX-6：创建失败 → INPUT_POST_ACCESS_DENIED。
            return inputPostFail(error, recovery: "检查 combo/plan 后重试")
        }

    case "scroll":
        guard let args = request["args"] as? [String: Any] else { return usageFail("scroll 需要 args") }
        guard let dyRaw = (args["dy"] as? NSNumber)?.intValue else {
            return usageFail("scroll 需要 args.dy（正=上，负=下）")
        }
        let dxRaw = (args["dx"] as? NSNumber)?.intValue ?? 0
        // A6：Int32(exactly:) 严查——超界报错而不是 Int32(truncating) 静默截断（CGEvent 消费 Int32）。
        guard let dy = Int32(exactly: dyRaw), let dx = Int32(exactly: dxRaw) else {
            return usageFail("scroll 的 dx/dy 超出 Int32 范围: dy=\(dyRaw) dx=\(dxRaw)")
        }
        let x = (args["x"] as? NSNumber)?.doubleValue ?? CGFloat(NSScreen.main?.frame.midX ?? 0)
        let y = (args["y"] as? NSNumber)?.doubleValue ?? CGFloat(NSScreen.main?.frame.midY ?? 0)
        // 坐标 sanity：非有限值（NaN/inf）会让 CGEvent 定位到未定义位置，直接拒绝。
        guard x.isFinite, y.isFinite else {
            return usageFail("scroll 的 x/y 必须是有限数字: x=\(x) y=\(y)")
        }
        // scroll 是 Tier 2 全局事件；带 windowId 则执行前台纪律。
        var entryId: String? = nil
        if let windowId = args["windowId"] as? String {
            let resolution = resolveOr(windowId)
            guard case .entry(let entry) = resolution else {
                if case .envelope(let envelope) = resolution { return envelope }
                return usageFail("scroll 句柄解析异常", recovery: "computer_windows 重新获取句柄")
            }
            if let f = frontmostFailureIfAny(entry) {
                return fail(f.message, code: f.code, retryable: f.retryable, recovery: f.recovery)
            }
            entryId = entry.windowId
        }
        do {
            // QA 终轮：Tier 2 权限门槛。
            if let gate = postEventGate(id.intValue) { return gate }
            try postScroll(x: x, y: y, dx: dx, dy: dy)
            var out: [String: Any] = [
                "dx": Int(dx), "dy": Int(dy),
                "mode": "global-cgevent", "delivery": "posted-unverified",
            ]
            if let wid = entryId { out["windowId"] = wid }
            return reply(out)
        } catch {
            // QA FIX-6：创建失败 → INPUT_POST_ACCESS_DENIED。
            return inputPostFail(error, recovery: "检查坐标是否在屏幕范围内后重试")
        }

    case "menu":
        guard let args = request["args"] as? [String: Any],
              let pid = (args["pid"] as? NSNumber)?.intValue else {
            return usageFail("menu 需要 args.pid", recovery: "pid 来自 computer_list_apps")
        }
        guard let rawPath = args["path"] as? [Any],
              !rawPath.isEmpty,
              let path = rawPath.compactMap({ $0 as? String }) as [String]?, path.count == rawPath.count else {
            return usageFail("menu 需要 args.path（菜单路径数组，如 [\"文件\",\"新建\"]）")
        }
        if args["activate"] as? Bool ?? true {
            _ = activateApp(pid: pid_t(pid))
            usleep(80_000) // 等 app 真正到前台再点菜单
        }
        let out = clickMenu(pid: pid_t(pid), path: path)
        if let error = out["error"] as? String {
            return fail(error, code: "MENU_ERROR", retryable: false,
                        recovery: "重新 computer_list_apps 确认 app；或核对菜单路径拼写")
        }
        return reply(out)

    case "selfTest":
        // 纯函数自测通道（QA 细节收尾）：不触碰 GUI/输入事件，只回显 utf16Batches 的
        // 切批结果供 node:test 断言代理对边界（emoji 跨批 / 孤立代理 / 精确 20 边界）。
        guard let args = request["args"] as? [String: Any],
              let text = args["text"] as? String else {
            return usageFail("selfTest 需要 args.text")
        }
        let maxLen = (args["maxLen"] as? NSNumber)?.intValue ?? 20
        let batches = utf16Batches(Array(text.utf16), maxLen: maxLen)
        return reply([
            "batchCount": batches.count,
            "batches": batches.map { $0.map { Int($0) } },
        ])

    case "app":
        guard let args = request["args"] as? [String: Any],
              let verb = args["verb"] as? String else {
            return usageFail("app 需要 args.verb（launch/activate/quit）")
        }
        switch verb {
        case "launch":
            guard let bundleId = args["bundleId"] as? String, !bundleId.isEmpty else {
                return usageFail("launch 需要 args.bundleId（如 com.apple.TextEdit）")
            }
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
                return usageFail("找不到 bundleId=\(bundleId) 对应的 app",
                                 recovery: "computer_list_apps 确认 app 是否在运行；核对 bundleId")
            }
            // openApplicationAtURL 是 macOS 11+ 推荐异步 API；launchApplication(at:) 已弃用。
            let semaphore = DispatchSemaphore(value: 0)
            var launchError: String? = nil
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error { launchError = error.localizedDescription }
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 15) == .success else {
                return fail("launch 超时（15s）: \(bundleId)", code: "LAUNCH_TIMEOUT",
                            retryable: false, recovery: "重试；或 computer_list_apps 确认是否已启动")
            }
            if let launchError {
                return fail("launch 失败: \(launchError)", code: "LAUNCH_FAILED",
                            retryable: false, recovery: "核对 bundleId 后重试")
            }
            return reply(["verb": "launch", "bundleId": bundleId])
        case "activate":
            guard let pid = (args["pid"] as? NSNumber)?.intValue else {
                return usageFail("activate 需要 args.pid", recovery: "pid 来自 computer_list_apps")
            }
            // QA 终轮：与 windowAction.activate 同款——发请求不算成功，app 真到前台才算。
            guard activateAppVerified(pid: pid_t(pid)) else {
                return fail("activate 已执行但 pid=\(pid) 未在预算内（~300ms）成为前台（不可激活/已退出/被弹窗阻塞）",
                            code: "ACTIVATE_FAILED", retryable: true,
                            recovery: "computer_list_apps 确认 pid 存活；检查 app 是否有弹窗")
            }
            return reply(["verb": "activate", "pid": pid])
        case "quit":
            guard let pid = (args["pid"] as? NSNumber)?.intValue else {
                return usageFail("quit 需要 args.pid", recovery: "pid 来自 computer_list_apps")
            }
            guard let running = NSRunningApplication(processIdentifier: pid_t(pid)) else {
                return fail("quit 失败：pid=\(pid) 不在运行", code: "WINDOW_GONE",
                            retryable: false, recovery: "computer_list_apps 确认 app 状态")
            }
            // A7+F5：优雅退出（触发未保存提示），不 SIGTERM 强杀。
            // requested = 「我们已发出退出请求」（恒 true，走到这里即已请求）；
            // accepted = terminate() 的返回值（系统是否接受）。两个字段分开上报，不假装成功。
            let accepted = running.terminate()
            return reply(["verb": "quit", "pid": pid, "requested": true, "accepted": accepted])
        default:
            return usageFail("未知 verb: \(verb)（支持 launch/activate/quit）")
        }
    default:
        return fail("unknown op: \(op)（支持 ping/doctor/listApps/listWindows/snapshot/windowAction/resolveCapture/click/type/key/scroll/menu/app/selfTest）",
                    code: "UNKNOWN_OP", retryable: false,
                    recovery: "按支持列表修正 op 名")
    }
}

// 主循环：stdout 彻底留给协议；行缓冲读 stdin，EOF 退出（无 runloop、无 AXObserver，ADR-3）。
func main() {
    setvbuf(stdout, nil, _IOLBF, 0)
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            emit(["id": 0, "ok": false, "error": "malformed request line",
                  "code": "MALFORMED_REQUEST", "retryable": false,
                  "recovery": "每行一个 JSON 请求对象"])
            continue
        }
        emit(handle(request))
    }
}

main()
