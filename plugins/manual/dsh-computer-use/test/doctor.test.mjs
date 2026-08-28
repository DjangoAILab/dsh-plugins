import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformCheck, driverProbe, ensureDriverCompiled, GUIDANCE } from '../src/doctor.mjs'
import { resolveDriverPaths } from '../src/config.mjs'

test('platformCheck: darwin supported, others fail-closed with reason', () => {
  assert.deepEqual(platformCheck('darwin'), { supported: true })
  const linux = platformCheck('linux')
  assert.equal(linux.supported, false)
  assert.match(linux.reason, /macOS/)
})

test('ensureDriverCompiled: missing source fails', async () => {
  const r = await ensureDriverCompiled({ driverDir: '/nonexistent-ax-xyz' })
  assert.equal(r.ok, false)
  assert.match(r.error, /源码缺失/)
})

test('ensureDriverCompiled: missing swiftc fails cleanly', async () => {
  const r = await ensureDriverCompiled(
    { driverDir: import.meta.dirname + '/../driver', swiftcPath: '/nonexistent/swiftc' },
    () => {},
  )
  // 宿主上有 driver 源码；若已有编译产物则跳过 swiftc 检查，两种结果都合法。
  assert.ok(r.ok === true || /swiftc/.test(r.error), JSON.stringify(r))
})

test('driverProbe: missing binary fails without throwing', async () => {
  const r = await driverProbe('/nonexistent-ax-xyz/axdriver', { id: 1, op: 'ping' }, 2000)
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('GUIDANCE: accessibility guidance mentions 系统设置 and responsible-process nuance', () => {
  assert.match(GUIDANCE.accessibility, /辅助功能/)
  assert.match(GUIDANCE.accessibility, /责任进程/)
  assert.match(GUIDANCE.screenRecording, /屏幕录制/)
})

test('driverPaths default points into plugin driver dir', () => {
  const p = resolveDriverPaths({})
  assert.match(p.source, /driver\/axdriver\.swift$/)
  assert.match(p.binary, /driver\/axdriver$/)
})
