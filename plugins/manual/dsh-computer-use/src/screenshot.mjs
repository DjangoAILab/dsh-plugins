// screenshot.mjs — screencapture 落盘 + 降采样预算控制（阶段③）。
//
// 职责边界：只截屏存 PNG 并返回路径；读图交给 modlens_read_image 等视觉能力
// （纯文本模型读不了像素，不接附件管道——承 P0.5 browser_screenshot 既有决议）。
//
// 窗口 id 获取（v0.2.0 变更）：`screencapture -l <id>` 需要的 CGWindowNumber 现由
// driver 的 WindowRegistry 统一签发——listWindows 做初绑（frame+title 唯一匹配），
// resolveCapture 在截图前重核 pid/title/frame（替代旧独立 winid 探针 + TOCTOU 双解析）。
// 本文件只剩纯「截屏/降采样」机械层，不再做任何窗口解析。
//
// 设计权威：knowledge/domains/computer-use/accessibility-tree-drivers.md §五
// （截图 = 无 AX 树兜底 / 动作后确认，不是主观察）；
// window-object-and-input-backends-design.md ADR-1（CGWindowNumber 只是 capture binding）。

import { execFile } from 'node:child_process'
import { statSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
}

/**
 * screencapture 截屏落盘。目录按 0o700 建（截图是屏幕内容，收紧到属主可读）。
 * 失败时清理半截文件（unlink），不留损坏 PNG 给下游 modlens 读图。
 * @param {object} o
 * @param {string} o.file 目标 PNG 绝对路径
 * @param {number|null} o.windowId CGWindowNumber（null = 主屏；多屏时 screencapture 每屏一文件，本工具只返回主屏文件）。由 driver resolveCapture 签发（capture binding，非窗口身份）
 * @param {boolean} o.noShadow 窗口模式去阴影（默认 true）
 * @returns {Promise<{ ok: boolean, bytes?: number, error?: string }>}
 */
export async function captureTo({ file, windowId = null, noShadow = true }) {
  const dir = dirname(file)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // F12：mkdir recursive 对「已存在」的目录不补 chmod——截图是屏幕内容，旧目录同样
    // 收紧到 0700（best-effort：只读卷等失败不阻塞截图本身）。
    try { chmodSync(dir, 0o700) } catch { /* best effort */ }
  } catch (e) {
    return { ok: false, error: '截图目录不可创建: ' + dir + ' (' + e.message + ')' }
  }
  const args = ['-x'] // 静默（不出快门声）
  if (windowId !== null) {
    args.push('-l', String(windowId))
    if (noShadow) args.push('-o')
  }
  args.push(file)
  const out = await runFile('/usr/sbin/screencapture', args, 20000)
  if (out.err || !existsSync(file)) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best effort */ }
    return { ok: false, error: 'screencapture 失败: ' + (out.stderr || out.err?.message || 'no output file') }
  }
  // F12：截图文件收紧到属主可读写（0600，best-effort）。
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
  try {
    return { ok: true, bytes: statSync(file).size }
  } catch (e) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best effort */ }
    return { ok: false, error: 'screenshot stat 失败: ' + e.message }
  }
}

/**
 * 降采样到长边上限（sips，幂等覆盖到 tmp 后回写）。
 * F12：sips 失败时删除落盘文件——capture 文件是本工具的内部中间产物，保留未按预算降采样的
 * 屏幕原图等于把内容泄漏在截图目录；报错让模型重新 computer_screenshot。
 * @returns {Promise<{ ok: boolean, bytes?: number, downscaled?: boolean, error?: string }>}
 */
export async function downscale(file, maxDimension) {
  if (!maxDimension || maxDimension <= 0) return { ok: true, downscaled: false }
  const out = await runFile('/usr/bin/sips', ['-Z', String(Math.floor(maxDimension)), file], 30000)
  if (out.err) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best effort */ }
    return { ok: false, error: 'sips 降采样失败: ' + String(out.stderr).slice(-200) }
  }
  try {
    return { ok: true, bytes: statSync(file).size, downscaled: true }
  } catch (e) {
    // QA 复审（2026-08-31）：sips 成功但 stat 失败同属失败路径——屏幕原图一样不残留。
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best effort */ }
    return { ok: false, error: 'screenshot stat 失败: ' + e.message }
  }
}
