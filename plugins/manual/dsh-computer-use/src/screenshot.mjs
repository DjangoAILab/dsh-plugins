// screenshot.mjs — 阶段③：screencapture 落盘 + 降采样预算控制。
//
// 职责边界：只截屏存 PNG 并返回路径；读图交给 modlens_read_image 等视觉能力
// （纯文本模型读不了像素，不接附件管道——承 P0.5 browser_screenshot 既有决议）。
//
// 窗口 id 获取：`screencapture -l <id>` 需要 CGWindowNumber，而 AX 树的 ref 不携带它，
// 故用迷你 Swift 探针（复用 driver 编译产物同款 swiftc）列 on-screen 窗口并按 pid+index 匹配。
//
// 设计权威：knowledge/domains/computer-use/accessibility-tree-drivers.md §五
// （截图 = 无 AX 树兜底 / 动作后确认，不是主观察）。

import { execFile } from 'node:child_process'
import { statSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const WINID_SWIFT = [
  'import CoreGraphics',
  'import ApplicationServices',
  '',
  'let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]',
  'guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }',
  'for w in list {',
  '    let owner = w["kCGWindowOwnerName"] as? String ?? "?"',
  '    let pid = w["kCGWindowOwnerPID"] as? Int32 ?? 0',
  '    let num = w["kCGWindowNumber"] as? Int32 ?? 0',
  '    let name = w["kCGWindowName"] as? String ?? ""',
  '    let layer = w["kCGWindowLayer"] as? Int32 ?? 0',
  '    if layer == 0 {',
  '        let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]',
  '        print("\\(num)\\t\\(pid)\\t\\(owner)\\t\\(name)\\t\\(bounds)")',
  '    }',
  '}',
  '',
].join('\n')

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
}

/**
 * 编译并运行窗口 id 探针，返回 [{ id, pid, owner, name, bounds }]。
 * 探针源码落 driver 目录旁（winid.swift），编译产物 winid 幂等复用。
 */
export async function listWindowIds(cfg) {
  const dir = cfg.driverDirResolved || '/tmp'
  const binary = join(dir, 'winid')
  const source = join(dir, 'winid.swift')
  if (!existsSync(binary)) {
    // 目录不存在先建（编译产物 + 源码都在这里）；mkdir 失败给可读错误而不是裸 ENOENT。
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e) {
      throw new Error('winid 探针目录不可创建: ' + dir + ' (' + e.message + ')')
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(source, WINID_SWIFT)
    const build = await runFile(cfg.swiftcPath || '/usr/bin/swiftc', ['-O', '-o', binary, source], 120000)
    if (build.err && !existsSync(binary)) {
      throw new Error('winid 探针编译失败: ' + String(build.stderr).slice(-300))
    }
  }
  const out = await runFile(binary, [], 10000)
  if (out.err && !out.stdout) throw new Error('winid 探针运行失败: ' + out.err.message)
  const windows = []
  for (const line of String(out.stdout).split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const boundsRaw = parts.slice(4).join('\t')
    let bounds = {}
    try {
      const m = boundsRaw.match(/\{([^}]*)\}/)
      if (m) {
        for (const kv of m[1].split(', ')) {
          const [k, v] = kv.split(': ').map((s) => s.trim().replace(/"/g, ''))
          if (k && v !== undefined) bounds[k] = Number(v)
        }
      }
    } catch { /* bounds optional */ }
    windows.push({
      id: Number(parts[0]),
      pid: Number(parts[1]),
      owner: parts[2],
      name: parts[3],
      bounds,
    })
  }
  return windows
}

/** 找 pid 的第 windowIndex 个 CGWindow（按 CGWindowList 顺序，与 AX w<N> 大体一致但非严格同源）。 */
export async function resolveWindowId(cfg, pid, windowIndex = 0) {
  const windows = (await listWindowIds(cfg)).filter((w) => w.pid === pid)
  if (windows.length === 0) return null
  const idx = Math.max(0, Math.min(windowIndex, windows.length - 1))
  return windows[idx]
}

/**
 * screencapture 截屏落盘。
 * @param {object} o
 * @param {string} o.file 目标 PNG 绝对路径
 * @param {number|null} o.windowId CGWindowNumber（null = 全部显示器拼接）
 * @param {boolean} o.noShadow 窗口模式去阴影（默认 true）
 * @returns {Promise<{ ok: boolean, bytes?: number, error?: string }>}
 */
export async function captureTo({ file, windowId = null, noShadow = true }) {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    return { ok: false, error: '截图目录不可创建: ' + dirname(file) + ' (' + e.message + ')' }
  }
  const args = ['-x'] // 静默（不出快门声）
  if (windowId !== null) {
    args.push('-l', String(windowId))
    if (noShadow) args.push('-o')
  }
  args.push(file)
  const out = await runFile('/usr/sbin/screencapture', args, 20000)
  if (out.err || !existsSync(file)) {
    return { ok: false, error: 'screencapture 失败: ' + (out.stderr || out.err?.message || 'no output file') }
  }
  try {
    return { ok: true, bytes: statSync(file).size }
  } catch (e) {
    return { ok: false, error: 'screenshot stat 失败: ' + e.message }
  }
}

/**
 * 降采样到长边上限（sips，幂等覆盖到 tmp 后回写）。
 * @returns {Promise<{ ok: boolean, bytes?: number, downscaled?: boolean, error?: string }>}
 */
export async function downscale(file, maxDimension) {
  if (!maxDimension || maxDimension <= 0) return { ok: true, downscaled: false }
  const out = await runFile('/usr/bin/sips', ['-Z', String(Math.floor(maxDimension)), file], 30000)
  if (out.err) return { ok: false, error: 'sips 降采样失败: ' + String(out.stderr).slice(-200) }
  try {
    return { ok: true, bytes: statSync(file).size, downscaled: true }
  } catch (e) {
    return { ok: false, error: 'screenshot stat 失败: ' + e.message }
  }
}
