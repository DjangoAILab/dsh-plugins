import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformCheck, driverProbe, ensureDriverCompiled, GUIDANCE } from '../src/doctor.mjs'
import { resolveDriverPaths } from '../src/config.mjs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---- stub swiftc 工厂（D4）----
// ensureDriverCompiled 通过 cfg.swiftcPath 调 swiftc；stub 用 shell 脚本模拟：
// 解析 -o 参数写产物文件，可附加 sleep（放大并发窗口）与计数文件（断言 spawn 次数）。

function stubSwiftc(t, { fail = false, sleepSec = 0, countFile = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'axdoc-test-'))
  const script = join(dir, 'fake-swiftc.sh')
  const lines = [
    '#!/bin/sh',
    'out=""; prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-o" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
  ]
  if (sleepSec) lines.push(`sleep ${sleepSec}`)
  if (fail) {
    lines.push('echo "mock swiftc boom: cannot find module MockFake" >&2')
    lines.push('exit 1')
  } else {
    lines.push('printf "FAKE-BIN" > "$out"')
  }
  if (countFile) lines.push(`echo spawned >> "${countFile}"`)
  writeFileSync(script, lines.join('\n'), { mode: 0o755 })
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  return script
}

function fixtureDriverDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'axdoc-driver-'))
  writeFileSync(join(dir, 'axdriver.swift'), '// not real swift; stub swiftc 不关心内容')
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  return dir
}

function touch(path, ms) {
  const t = new Date(ms)
  utimesSync(path, t, t)
}

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

test('ensureDriverCompiled: 编译失败时 stderr 末段进入错误信息（不再报 log.name）', async (t) => {
  const dir = fixtureDriverDir(t)
  const swiftc = stubSwiftc(t, { fail: true })
  const r = await ensureDriverCompiled({ driverDir: dir, swiftcPath: swiftc })
  assert.equal(r.ok, false)
  assert.match(r.error, /swiftc 编译失败/)
  assert.match(r.error, /mock swiftc boom/, '必须携带 swiftc 的 stderr（模型据此自愈）')
  assert.doesNotMatch(r.error, /log\b/, '不得再误报 log 函数名')
  // 失败后不留临时产物
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('ensureDriverCompiled: 单飞 — 并发调用只 spawn 一次 swiftc', async (t) => {
  const dir = fixtureDriverDir(t)
  const countFile = join(dir, 'spawn-count')
  const swiftc = stubSwiftc(t, { sleepSec: 0.4, countFile })
  const cfg = { driverDir: dir, swiftcPath: swiftc }
  const [a, b, c] = await Promise.all([
    ensureDriverCompiled(cfg), ensureDriverCompiled(cfg), ensureDriverCompiled(cfg),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, true)
  // 单飞 = 共享同一 in-flight Promise：三者拿到同一结果对象。
  assert.equal(a.compiled, true)
  assert.equal(b, a, '并发调用共享同一 in-flight 结果')
  assert.equal(c, a, '并发调用共享同一 in-flight 结果')
  const spawns = readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(spawns.length, 1, '三个并发调用必须共享一次 swiftc spawn')
})

test('ensureDriverCompiled: binary 较新跳过编译；source 较新触发重编译', async (t) => {
  const dir = fixtureDriverDir(t)
  const countFile = join(dir, 'spawn-count')
  const swiftc = stubSwiftc(t, { countFile })
  const cfg = { driverDir: dir, swiftcPath: swiftc }
  const now = Date.now()

  // ① 无 binary → 编译（1 次）
  const first = await ensureDriverCompiled(cfg)
  assert.equal(first.ok, true)
  assert.equal(first.compiled, true)

  // ② binary 比 source 新 → 跳过
  touch(join(dir, 'axdriver.swift'), now - 60_000)
  touch(join(dir, 'axdriver'), now)
  const second = await ensureDriverCompiled(cfg)
  assert.equal(second.ok, true)
  assert.equal(second.compiled, false, 'binary 较新必须跳过编译')

  // ③ source 比 binary 新 → 重编译
  touch(join(dir, 'axdriver.swift'), now + 60_000)
  const third = await ensureDriverCompiled(cfg)
  assert.equal(third.ok, true)
  assert.equal(third.compiled, true, 'source 较新必须重编译')

  const spawns = readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(spawns.length, 2, '总共恰好两次 swiftc spawn（跳过 + 重编译）')
  // 原子落位：目录里没有 *.tmp-* 残留
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})
