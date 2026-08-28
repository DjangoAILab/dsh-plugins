// screenshot.mjs 纯逻辑测试：winid 输出解析、路径预算语义。screencapture 本体只在宿主手测。

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('listWindowIds: unreadable driver dir → throws readable error (no裸 ENOENT)', async () => {
  const { listWindowIds } = await import('../src/screenshot.mjs')
  await assert.rejects(
    () => listWindowIds({ driverDirResolved: '/proc/1/forbidden-xyz', swiftcPath: '/usr/bin/swiftc' }),
    (err) => /winid 探针目录不可创建|探针编译失败/.test(String(err && err.message)),
  )
})

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

test('downscale: missing file fails cleanly', async () => {
  const { downscale } = await import('../src/screenshot.mjs')
  const r = await downscale('/nonexistent-xyz.png', 1280)
  assert.equal(r.ok, false)
  assert.ok(r.error)
})
