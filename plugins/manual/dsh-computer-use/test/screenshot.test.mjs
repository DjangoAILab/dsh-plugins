// screenshot.mjs 纯逻辑测试：screencapture 落盘卫生与降采样预算语义。
// v0.2.0：独立 winid 探针已删——窗口 id 解析（listWindows 初绑 + resolveCapture 重核）
// 由 driver WindowRegistry 承担，其行为在 test/window-registry.test.mjs 用 stub 覆盖。
// screencapture 本体只在宿主手测；这里不碰真实截图。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('captureTo: missing screencapture binary or bad path fails without throw', async () => {
  const { captureTo } = await import('../src/screenshot.mjs')
  const r = await captureTo({ file: '/nonexistent-dir-xyz/a.png', windowId: null })
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('downscale: non-positive maxDimension is a no-op', async () => {
  const { downscale } = await import('../src/screenshot.mjs')
  const r = await downscale('/nonexistent.png', 0)
  assert.equal(r.ok, true)
  assert.equal(r.downscaled, false)
})

test('downscale: missing file fails cleanly and cleans the partial file (F12)', async () => {
  const { downscale } = await import('../src/screenshot.mjs')
  const partial = join(tmpdir(), 'winid-downscale-partial-' + process.pid + '.png')
  writeFileSync(partial, 'fake capture bytes')
  try {
    const r = await downscale(partial, 1280) // sips 对假 PNG 会失败
    assert.equal(r.ok, false)
    assert.match(String(r.error), /sips 降采样失败/)
    assert.equal(existsSync(partial), false, '降采样失败必须删除落盘文件（不泄漏未降采样原图）')
  } finally {
    try { rmSync(partial, { force: true }) } catch { /* best effort */ }
  }
})

test('screenshot.mjs: v0.2.0 起不再导出 winid 探针（独立窗口解析已并入 driver registry）', async () => {
  const mod = await import('../src/screenshot.mjs')
  for (const gone of ['listWindowIds', 'resolveWindowId', 'assertWindowIdStable', 'WINID_SWIFT']) {
    assert.equal(mod[gone], undefined, gone + ' 必须已删除（由 driver listWindows/resolveCapture 替代）')
  }
  // 保留的机械层：captureTo / downscale。
  assert.equal(typeof mod.captureTo, 'function')
  assert.equal(typeof mod.downscale, 'function')
})
