// WindowRegistry 行为测试（v0.2.0 ADR-1/ADR-3/ADR-4 + QA FIX-1/2/5/7）：
//   第一部分：用一个**有状态** stub driver 模拟 registry 的签发/沿用（CFEqual 对齐的代理 =
//   稳定 fake element id）/tombstone(+TTL)/前台纪律/截图绑定（FIX-2 title 纪律）/type fallback
//   （FIX-1b inputMode 纪律），验证 Node 侧工具层契约与错误信封自愈路径。
//   第二部分（FIX-7）：真实 driver 只读探针——二进制由 test/helpers/driver-build.mjs 从当前
//   工作树源码现场编译（绝不用 driver/axdriver 陈旧产物），仅 listWindows/snapshot/ping 等
//   只读 op，不触碰真实 GUI 输入/截屏（AGENTS.md §八）；swiftc 不可用或非 darwin 时跳过。
//   真实 AX/CG 的破坏性行为只能在宿主 macOS 手测（stub 与真 driver 的 reconcile 语义一致性
//   由 driver 内注释与设计文档约束）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.mjs'
import { mountComputerTools } from '../src/tools.mjs'
import { closeAll, call } from '../src/session.mjs'
import { ensureDriverCompiled } from '../src/doctor.mjs'
import { compileDriverForTest } from './helpers/driver-build.mjs'

// 有状态 stub：testSet 下发 fake 窗口（稳定 eid 即「同一扇窗」），listWindows 按
// eid 对齐沿用 windowId（等价真 driver 的 CFEqual），消失者转 tombstone（带虚拟时钟 TTL）。
const REGISTRY_STUB = [
  '#!/usr/bin/env node',
  "const state = { seq: 0, entries: new Map(), tombstones: new Map(), fake: [], cg: [], now: Date.now() };",
  "let buf = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (d) => {",
  '  buf += d;',
  '  let nl;',
  "  while ((nl = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
  '    if (!line) continue;',
  '    let req; try { req = JSON.parse(line) } catch { continue }',
  '    handle(req);',
  '  }',
  '})',
  'function send(o) { process.stdout.write(JSON.stringify(o) + "\\n") }',
  'function fail(id, f) { send({ id, ok: false, error: f.error, code: f.code, retryable: f.retryable, recovery: f.recovery }) }',
  'function sameFrame(a, b) {',
  "  return ['x', 'y', 'width', 'height'].every((k) => Math.abs(((a || {})[k] || 0) - ((b || {})[k] || 0)) <= 2)",
  '}',
  'function resolve(wid) {',
  "  if (typeof wid !== 'string') return { fail: { error: '需要 windowId', code: 'INVALID_ARGUMENT', retryable: false, recovery: 'computer_windows' } }",
  "  if (!wid.startsWith('win_stub_')) return { fail: { error: wid.startsWith('win_') ? 'windowId ' + wid + ' 来自已重启的 driver 会话' : 'windowId 格式非法: ' + wid, code: wid.startsWith('win_') ? 'WINDOW_SESSION_EXPIRED' : 'WINDOW_UNKNOWN', retryable: false, recovery: 'computer_windows 重新获取句柄' } }",
  '  for (const e of state.entries.values()) if (e.windowId === wid) return { entry: e }',
  '  // QA FIX-5：tombstone 带 TTL（10 分钟，与真 driver TOMBSTONE_TTL 一致）——过期后身份',
  '  // 残片已清，旧句柄应报 WINDOW_UNKNOWN 而不是永远 WINDOW_GONE。',
  '  const tb = state.tombstones.get(wid)',
  '  if (tb) {',
  '    if (state.now - tb.at > 600000) return { fail: { error: "windowId 已过期（tombstone TTL 满，身份残片已清）", code: "WINDOW_UNKNOWN", retryable: false, recovery: "computer_windows 重新获取句柄" } }',
  '    return { fail: { error: "windowId 已关闭（tombstone）", code: "WINDOW_GONE", retryable: false, recovery: "computer_windows 重新获取句柄" } }',
  '  }',
  "  return { fail: { error: '未知句柄', code: 'WINDOW_UNKNOWN', retryable: false, recovery: 'computer_windows' } }",
  '}',
  '// QA FIX-2：frame+title 绑定纪律——AX title 非空且 CG 候选带可用窗名时必须精确一致；',
  '// 全部候选都无可用窗名时才允许纯 frame 唯一匹配；歧义一律 null。',
  'function bindWin(e, cands) {',
  '  const fc = cands.filter((c) => sameFrame(c.frame, e.frame))',
  '  if (fc.length === 0) return null',
  '  if (e.title) {',
  '    const withName = fc.filter((c) => typeof c.name === "string" && c.name !== "")',
  '    if (withName.length === 0) return fc.length === 1 ? fc[0] : null',
  '    const titled = withName.filter((c) => c.name === e.title)',
  '    return titled.length === 1 ? titled[0] : null',
  '  }',
  '  return fc.length === 1 ? fc[0] : null',
  '}',
  'function reconcile(pid) {',
  '  const targets = state.fake.filter((w) => pid === undefined || w.pid === pid)',
  '  const used = new Set()',
  '  const out = []',
  '  for (const w of targets) {',
  '    let e = state.entries.get(w.eid)',
  '    if (!e) {',
  '      state.seq += 1',
  "      e = { windowId: 'win_stub_' + state.seq, pid: w.pid }",
  '      state.entries.set(w.eid, e)',
  '    }',
  "    e.appName = w.appName || ('pid-' + w.pid)",
  '    e.title = w.title; e.frame = w.frame; e.main = w.main; e.minimized = w.minimized',
  '    used.add(w.eid)',
  '    const cands = state.cg.filter((c) => c.pid === w.pid)',
  '    const hit = bindWin(e, cands)',
  '    e.cgNumber = hit ? hit.number : null',
  '    e.captureAvailable = hit !== null',
  '    out.push(e)',
  '  }',
  '  for (const [eid, e] of Array.from(state.entries)) {',
  '    if (!used.has(eid) && (pid === undefined || e.pid === pid)) { state.entries.delete(eid); state.tombstones.set(e.windowId, { at: state.now }) }',
  '  }',
  '  return out',
  '}',
  'function winItem(e) { return Object.assign({ windowId: e.windowId, pid: e.pid, appName: e.appName },',
  '  e.title ? { title: e.title } : {}, e.frame ? { frame: e.frame } : {},',
  '  { minimized: e.minimized === true, main: e.main === true, captureAvailable: e.captureAvailable === true }) }',
  'function frontmostOr(id, wid, a) {',
  '  const r = resolve(wid)',
  '  if (r.fail) { fail(id, r.fail); return null }',
  '  if (r.entry.main !== true) {',
  "    fail(id, { error: 'windowId ' + wid + ' 不是全局前台窗口', code: 'INPUT_TARGET_NOT_FOCUSED', retryable: false, recovery: 'computer_window activate' })",
  '    return null',
  '  }',
  '  return r.entry',
  '}',
  'function handle(req) {',
  '  const a = req.args || {}',
  '  switch (req.op) {',
  '    case "testSet": {',
  '      // 虚拟时钟（FIX-5）：advanceMs 推进 state.now，用于触发 tombstone TTL 过期。',
  '      if (a.advanceMs) state.now += a.advanceMs',
  '      state.fake = a.windows || []; state.cg = a.cg || []',
  '      send({ id: req.id, ok: true, result: { set: true } }); return',
  '    }',
  '    case "ping": send({ id: req.id, ok: true, result: { pong: true, trusted: true, nonce: "stub" } }); return',
  '    case "listWindows": {',
  '      const pid = a.pid === undefined ? undefined : Number(a.pid)',
  '      const r = { windows: reconcile(pid).map(winItem) }',
  '      if (a.hint) r.hint = a.hint',
  '      send({ id: req.id, ok: true, result: r }); return',
  '    }',
  '    case "snapshot": {',
  '      const r = resolve(a.windowId)',
  '      if (r.fail) { fail(req.id, r.fail); return }',
  '      send({ id: req.id, ok: true, result: { windowId: r.entry.windowId, pid: r.entry.pid, title: r.entry.title || "w", nodeCount: 1, nodes: [{ ref: "@0", depth: 0, role: "AXWindow", title: r.entry.title || "w" }] } }); return',
  '    }',
  '    case "resolveCapture": {',
  '      const r = resolve(a.windowId)',
  '      if (r.fail) { fail(req.id, r.fail); return }',
  '      const hit = bindWin(r.entry, state.cg.filter((c) => c.pid === r.entry.pid))',
  '      if (hit) { send({ id: req.id, ok: true, result: { windowId: r.entry.windowId, cgWindowNumber: hit.number } }); return }',
  '      const fc = state.cg.filter((c) => c.pid === r.entry.pid && sameFrame(c.frame, r.entry.frame))',
  '      if (fc.length > 1) { fail(req.id, { error: fc.length + " 个 frame 相符 CG 窗口", code: "WINDOW_CAPTURE_AMBIGUOUS", retryable: false, recovery: "computer_window activate" }); return }',
  '      fail(req.id, { error: "无匹配 on-screen CG 记录（title/frame 不符或被隐藏）", code: "WINDOW_NOT_CAPTURABLE", retryable: false, recovery: "computer_window restore" }); return',
  '    }',
  '    case "windowAction": {',
  '      const r = resolve(a.windowId)',
  '      if (r.fail) { fail(req.id, r.fail); return }',
  '      if (a.verb === "minimize") r.entry.minimized = true',
  '      if (a.verb === "restore") r.entry.minimized = false',
  '      send({ id: req.id, ok: true, result: { windowId: r.entry.windowId, verb: a.verb, ok: true, minimized: r.entry.minimized === true } }); return',
  '    }',
  '    case "click": {',
  '      if (a.ref) {',
  '        const r = resolve(a.windowId)',
  '        if (r.fail) { fail(req.id, r.fail); return }',
  '        send({ id: req.id, ok: true, result: { mode: "ax-action", delivery: "acknowledged", windowId: r.entry.windowId, ref: a.ref, action: a.action || "AXPress" } }); return',
  '      }',
  '      let entry = null',
  '      if (a.windowId) { entry = frontmostOr(req.id, a.windowId, a); if (!entry) return }',
  '      if (a.x === undefined || a.y === undefined) { fail(req.id, { error: "click 需要 args.ref（来自 computer_snapshot，配合 windowId）或 args.x/args.y", code: "INVALID_ARGUMENT", retryable: false, recovery: "按错误信息修正参数" }); return }',
  '      send({ id: req.id, ok: true, result: { mode: "global-cgevent", delivery: "posted-unverified", x: a.x, y: a.y } }); return',
  '    }',
  '    case "type": {',
  '      if (a.ref) {',
  '        const r = resolve(a.windowId)',
  '        if (r.fail) { fail(req.id, r.fail); return }',
  '        // QA FIX-1b 模拟：@0/readonly = set value 失败的元素。driver 纪律：',
  '        //   inputMode=cursorless → INPUT_UNSUPPORTED（绝不 Tier 2）；',
  '        //   auto/global → 前台纪律（main）通过才允许聚焦注入 fallback。',
  '        if (a.ref === "@0/readonly") {',
  '          if (a.inputMode === "cursorless") { fail(req.id, { error: "set value 失败且 inputMode=cursorless 禁止退回 Tier 2 全局事件注入", code: "INPUT_UNSUPPORTED", retryable: false, recovery: "改用可 set value 的元素" }); return }',
  '          if (r.entry.main !== true) { fail(req.id, { error: "windowId " + r.entry.windowId + " 不是全局前台窗口（fallback 需前台纪律）", code: "INPUT_TARGET_NOT_FOCUSED", retryable: false, recovery: "computer_window activate" }); return }',
  '          send({ id: req.id, ok: true, result: { mode: "global-cgevent", delivery: "posted-unverified", windowId: r.entry.windowId, ref: a.ref, length: (a.text || "").length } }); return',
  '        }',
  '        send({ id: req.id, ok: true, result: { mode: "ax-value", delivery: "acknowledged", windowId: r.entry.windowId, ref: a.ref, length: (a.text || "").length } }); return',
  '      }',
  '      if (a.windowId) { const e = frontmostOr(req.id, a.windowId, a); if (!e) return }',
  '      send({ id: req.id, ok: true, result: { mode: "global-cgevent", delivery: "posted-unverified", length: (a.text || "").length } }); return',
  '    }',
  '    case "key": {',
  '      if (a.windowId) { const e = frontmostOr(req.id, a.windowId, a); if (!e) return }',
  '      send({ id: req.id, ok: true, result: { combo: a.combo, planned: true, mode: "global-cgevent", delivery: "posted-unverified" } }); return',
  '    }',
  '    case "scroll": {',
  '      if (a.windowId) { const e = frontmostOr(req.id, a.windowId, a); if (!e) return }',
  '      send({ id: req.id, ok: true, result: { dx: a.dx, dy: a.dy, mode: "global-cgevent", delivery: "posted-unverified" } }); return',
  '    }',
  '    default: fail(req.id, { error: "stub unknown op " + req.op, code: "UNKNOWN_OP", retryable: false, recovery: "n/a" })',
  '  }',
  '}',
  '',
].join('\n')

function makeFixtureDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'winreg-test-'))
  const binary = join(dir, 'axdriver')
  writeFileSync(binary, REGISTRY_STUB, { mode: 0o755 })
  // ensureDriverCompiled 跳过编译：dummy 源码 mtime 拨老。
  const source = join(dir, 'axdriver.swift')
  writeFileSync(source, '// registry stub source')
  const now = new Date()
  const past = new Date(now.getTime() - 10_000)
  utimesSync(source, past, past)
  utimesSync(binary, now, now)
  t.after(() => {
    try { closeAll(binary) } catch { /* noop */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ }
  })
  return { dir, binary }
}

function makeHarness(dir) {
  const registered = []
  const ctx = {
    tools: { register: (def) => { registered.push(def) } },
    effect: () => () => {},
    get: () => undefined,
  }
  const cfg = resolveConfig({ driverDir: dir, commandTimeoutMs: 5000 })
  mountComputerTools(ctx, cfg)
  return new Map(registered.map((d) => [d.name, d]))
}

const EXEC = { agent: {} }
const W = (over) => Object.assign({ pid: 100, appName: 'App', title: 'Doc', frame: { x: 0, y: 0, width: 500, height: 400 }, main: true, minimized: false }, over)

/** 测试公共件：挂工具 + 拿 testSet 下发器。 */
async function makeSuite(t) {
  const { dir, binary } = makeFixtureDir(t)
  const tools = makeHarness(dir)
  await tools.get('computer_doctor').execute({}, EXEC)
  const build = await ensureDriverCompiled(resolveConfig({ driverDir: dir, commandTimeoutMs: 5000 }))
  const setFake = (windows, cg = [], extra = {}) => call(build.binary, 'testSet', { windows, cg, ...extra }, 5000)
  return { tools, setFake, binary }
}

test('window-registry: 同一扇窗重列沿用句柄；新窗新句柄（ADR-1 reconcile）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  await setFake([W({ eid: 'e1' }), W({ eid: 'e2', title: 'Doc2' })])
  const first = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(first.windows.length, 2)
  const [id1a, id2a] = [first.windows[0].windowId, first.windows[1].windowId]
  assert.match(id1a, /^win_stub_\d+$/)

  // 重列同样两扇窗（同 eid = 同一扇窗）→ 句柄必须沿用
  await setFake([W({ eid: 'e1' }), W({ eid: 'e2', title: 'Doc2' })])
  const second = await tools.get('computer_windows').execute({}, EXEC)
  assert.deepEqual(second.windows.map((w) => w.windowId).sort(), [id1a, id2a].sort())

  // 新窗 e3 加入 → 新句柄；旧句柄不变
  await setFake([W({ eid: 'e1' }), W({ eid: 'e2', title: 'Doc2' }), W({ eid: 'e3', title: 'Doc3' })])
  const third = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(third.windows.length, 3)
  assert.equal(third.windows[2].windowId, 'win_stub_' + (Number(id2a.split('_')[2]) + 1))
})

test('window-registry: 窗口消失 → tombstone → [WINDOW_GONE] + recovery（ADR-3）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  await setFake([W({ eid: 'e1' })])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  const wid = listed.windows[0].windowId
  // snapshot 正常
  await tools.get('computer_snapshot').execute({ windowId: wid }, EXEC)
  // 窗口关闭（完整重列消失）→ tombstone
  await setFake([])
  await tools.get('computer_windows').execute({}, EXEC)
  await assert.rejects(
    () => tools.get('computer_snapshot').execute({ windowId: wid }, EXEC),
    (err) => {
      const msg = String(err.message)
      return msg.includes('[WINDOW_GONE]') && msg.includes('computer_windows')
    },
  )
})

test('window-registry: tombstone TTL 过期 → 身份残片已清，旧句柄报 [WINDOW_UNKNOWN]（QA FIX-5）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  await setFake([W({ eid: 'e1' })])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  const wid = listed.windows[0].windowId
  await setFake([]) // 窗口消失 → tombstone（buriedAt = 虚拟时钟当前值）
  await tools.get('computer_windows').execute({}, EXEC)
  await assert.rejects(
    () => tools.get('computer_snapshot').execute({ windowId: wid }, EXEC),
    /\[WINDOW_GONE\]/,
    'TTL 内必须仍报 WINDOW_GONE',
  )
  // 虚拟时钟推进 10 分钟 + 1ms → tombstone 过期：purge 后查找落空 → WINDOW_UNKNOWN。
  await setFake([], [], { advanceMs: 600001 })
  await assert.rejects(
    () => tools.get('computer_snapshot').execute({ windowId: wid }, EXEC),
    /\[WINDOW_UNKNOWN\]/,
    'TTL 过期后不得永远 WINDOW_GONE（QA FIX-5）',
  )
})

test('window-registry: 旧 nonce 句柄 → [WINDOW_SESSION_EXPIRED]（ADR-1）', async (t) => {
  const { tools } = await makeSuite(t)
  await assert.rejects(
    () => tools.get('computer_snapshot').execute({ windowId: 'win_oldproc_7' }, EXEC),
    /\[WINDOW_SESSION_EXPIRED\]/,
  )
  // 非 win_ 前缀 → WINDOW_UNKNOWN
  await assert.rejects(
    () => tools.get('computer_snapshot').execute({ windowId: 'pid-7-w0' }, EXEC),
    /\[WINDOW_UNKNOWN\]/,
  )
})

test('window-registry: 截图绑定唯一匹配才 captureAvailable；resolveCapture 歧义/不可截（ADR-1 binding）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  const frame = { x: 0, y: 0, width: 500, height: 400 }

  // 唯一 CG 匹配（候选无可用窗名 → 允许纯 frame 匹配）→ captureAvailable: true
  await setFake([W({ eid: 'e1' })], [{ pid: 100, number: 42, frame }])
  let listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, true)

  // 并列（两个同 frame CG 窗口）→ 绝不猜：captureAvailable: false
  await setFake([W({ eid: 'e1' })], [
    { pid: 100, number: 42, frame }, { pid: 100, number: 43, frame },
  ])
  listed = await tools.get('computer_windows').execute({}, EXEC)
  const wid = listed.windows[0].windowId
  assert.equal(listed.windows[0].captureAvailable, false)
  await assert.rejects(
    () => tools.get('computer_screenshot').execute({ mode: 'window', windowId: wid }, EXEC),
    /\[WINDOW_CAPTURE_AMBIGUOUS\]/,
  )

  // 无 CG 记录（最小化）→ WINDOW_NOT_CAPTURABLE
  await setFake([W({ eid: 'e1' })], [])
  await assert.rejects(
    () => tools.get('computer_screenshot').execute({ mode: 'window', windowId: wid }, EXEC),
    /\[WINDOW_NOT_CAPTURABLE\]/,
  )
})

test('window-registry: FIX-2 — 同尺寸不同题 CG 窗口存在 → 绝不 frame 拍绑（captureAvailable:false）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  const frame = { x: 0, y: 0, width: 500, height: 400 }
  // 唯一 frame 命中，但该候选带可用窗名且与 AX title 不一致 → 绑定必须失败。
  await setFake([W({ eid: 'e1', title: 'Doc' })], [{ pid: 100, number: 42, frame, name: 'Other Doc' }])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, false,
    'title 不符时绝不允许 frame-only 绑定（QA FIX-2）')
  await assert.rejects(
    () => tools.get('computer_screenshot').execute({ mode: 'window', windowId: listed.windows[0].windowId }, EXEC),
    /\[WINDOW_NOT_CAPTURABLE\]/,
  )
})

test('window-registry: FIX-2 — title 精确一致才绑；候选全无 CG 窗名才允许 frame-only', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  const frame = { x: 0, y: 0, width: 500, height: 400 }
  // ① title 精确一致 → 绑定
  await setFake([W({ eid: 'e1', title: 'Doc' })], [{ pid: 100, number: 42, frame, name: 'Doc' }])
  let listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, true)
  // ② 两个候选：一个 title 不符（有窗名）、一个无窗名 → 有窗名的那个不符即整体不绑
  //   （不许「绕开」不符候选去 frame 拍绑无名窗口）。
  await setFake([W({ eid: 'e1', title: 'Doc' })], [
    { pid: 100, number: 42, frame, name: 'Other' }, { pid: 100, number: 43, frame },
  ])
  listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, false)
  // ③ 候选带窗名且一致（即便同 frame 还有一个无名候选）→ 唯一 title 命中即绑。
  await setFake([W({ eid: 'e1', title: 'Doc' })], [
    { pid: 100, number: 42, frame, name: 'Doc' }, { pid: 100, number: 43, frame },
  ])
  listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, true)
  // ④ 候选 kCGWindowName 为空串（合法为空的窗口类型）→ 无可用窗名 → frame-only 唯一匹配允许。
  await setFake([W({ eid: 'e1', title: 'Doc' })], [{ pid: 100, number: 42, frame, name: '' }])
  listed = await tools.get('computer_windows').execute({}, EXEC)
  assert.equal(listed.windows[0].captureAvailable, true,
    '全部候选 CG 窗名合法为空时允许 frame-only 唯一匹配')
})

test('window-registry: FIX-1 — type set 失败 fallback 纪律：inputMode 透传 + cursorless 绝不 Tier 2', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  await setFake([W({ eid: 'e1' }), W({ eid: 'e2', title: 'bg', main: false })])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  const fg = listed.windows.find((w) => w.main === true)
  const bg = listed.windows.find((w) => w.main === false)

  // cursorless + set 失败：driver 侧必须报 INPUT_UNSUPPORTED（证明 inputMode 已透传——
  // stub 按 a.inputMode 分支；若 Node 没转发 inputMode，这里会走 fallback 而非报错）。
  await assert.rejects(
    () => tools.get('computer_type').execute(
      { text: 'x', windowId: fg.windowId, ref: '@0/readonly', inputMode: 'cursorless' }, EXEC),
    /\[INPUT_UNSUPPORTED\]/,
    'cursorless + set 失败绝不退全局 CGEvent（QA FIX-1b）',
  )
  // auto + set 失败 + 窗口非全局前台：fallback 需前台纪律 → INPUT_TARGET_NOT_FOCUSED。
  await assert.rejects(
    () => tools.get('computer_type').execute(
      { text: 'x', windowId: bg.windowId, ref: '@0/readonly' }, EXEC),
    /\[INPUT_TARGET_NOT_FOCUSED\]/,
    'auto fallback 必须过前台纪律（QA FIX-1b iii）',
  )
  // auto + set 失败 + 前台：允许聚焦注入 fallback，应答如实标注 global-cgevent/posted-unverified，
  // 且 ref/windowId 保留（Node 侧条件 spread）。
  const r = await tools.get('computer_type').execute(
    { text: 'x', windowId: fg.windowId, ref: '@0/readonly' }, EXEC)
  assert.equal(r.mode, 'global-cgevent')
  assert.equal(r.delivery, 'posted-unverified')
  assert.equal(r.ref, '@0/readonly')
  assert.equal(r.windowId, fg.windowId)
  // 正常可写元素仍是 ax-value/acknowledged。
  const ok = await tools.get('computer_type').execute(
    { text: 'x', windowId: fg.windowId, ref: '@0' }, EXEC)
  assert.equal(ok.mode, 'ax-value')
  assert.equal(ok.delivery, 'acknowledged')
})

test('window-registry: Tier 2 前台纪律 — key/scroll/坐标 click 带 windowId 需 main（INPUT_TARGET_NOT_FOCUSED）', async (t) => {
  const { tools, setFake } = await makeSuite(t)
  await setFake([W({ eid: 'e1' }), W({ eid: 'e2', main: false, title: 'bg' })])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  const bg = listed.windows.find((w) => w.main === false)
  assert.ok(bg, 'stub 应产出非 main 窗口')
  const fg = listed.windows.find((w) => w.main === true)

  for (const [tool, args] of [
    ['computer_key', { combo: 'return', windowId: bg.windowId }],
    ['computer_scroll', { dy: -1, windowId: bg.windowId }],
    ['computer_click', { x: 1, y: 2, windowId: bg.windowId }],
    ['computer_type', { text: 'x', windowId: bg.windowId }],
  ]) {
    await assert.rejects(
      () => tools.get(tool).execute(args, EXEC),
      /\[INPUT_TARGET_NOT_FOCUSED\]/,
      tool + ' 带 windowId 必须校验前台',
    )
  }
  // main 窗口通过；不带 windowId 也通过（直接投递当前前台）
  await tools.get('computer_key').execute({ combo: 'return', windowId: fg.windowId }, EXEC)
  await tools.get('computer_key').execute({ combo: 'return' }, EXEC)
  await tools.get('computer_click').execute({ x: 1, y: 2 }, EXEC)
})

test('window-registry: ref 不带 windowId → JS 侧拒绝（clean break，无 pid+windowIndex fallback）', async (t) => {
  const { tools } = await makeSuite(t)
  await assert.rejects(
    () => tools.get('computer_click').execute({ ref: '@0/1' }, EXEC),
    /\[INVALID_ARGUMENT\]/,
  )
  await assert.rejects(
    () => tools.get('computer_type').execute({ text: 'x', ref: '@0/1' }, EXEC),
    /\[INVALID_ARGUMENT\]/,
  )
  // 旧寻址参数彻底不存在：pid+windowIndex 不再是 click 的合法输入面（schema 未声明，工具直接忽略并因缺 ref/x-y 报错）
  await assert.rejects(
    () => tools.get('computer_click').execute({ pid: 8, windowIndex: 0 }, EXEC),
    /click 需要/,
  )
})

test('window-registry: resolveCapture 成功路径产出 cgWindowNumber 供截图（mock screencapture 层不执行）', async (t) => {
  const { tools, setFake, binary } = await makeSuite(t)
  const frame = { x: 0, y: 0, width: 500, height: 400 }
  await setFake([W({ eid: 'e1' })], [{ pid: 100, number: 77, frame }])
  const listed = await tools.get('computer_windows').execute({}, EXEC)
  const wid = listed.windows[0].windowId
  // 直接调 driver op 验证绑定重核产出（真实 screencapture 只在宿主手测，不入测试）。
  const resolved = await call(binary, 'resolveCapture', { windowId: wid }, 5000)
  assert.deepEqual(resolved, { windowId: wid, cgWindowNumber: 77 })
})

// ---- QA FIX-7：真实 driver 只读探针（当前工作树源码现场编译；非 darwin / 无 swiftc 跳过）----

test('real-driver: listWindows 两次重列 — 未变窗口 windowId 沿用（QA FIX-7，只读）', async (t) => {
  if (process.platform !== 'darwin') return t.skip('非 darwin 平台：真实 driver 探针只在宿主 macOS 运行')
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  t.after(() => { try { closeAll(build.binary) } catch { /* noop */ } })

  const l1 = await call(build.binary, 'listWindows', {}, 15000)
  const l2 = await call(build.binary, 'listWindows', {}, 15000)
  assert.ok(Array.isArray(l1.windows) && Array.isArray(l2.windows))
  // 同一 driver 进程（同 nonce）：以 (pid,title) 对齐的窗口必须沿用同一 windowId。
  // 注意用「同进程两次调用」——跨进程 nonce 不同，比对无意义。
  // QA 终轮修正（两轮独立唯一性）：**只断言「两轮 (pid,title) 都唯一且同时存在」的窗口**。
  // 同 app 多窗同题（如 Edge 每窗 AX title 都是 'Edge'）时内容键有歧义，内容相同 ≠
  // 同一窗口——身份对齐是 driver 内部用 CFEqual 做的，内容键只是测试的近似。
  // 可比较集合为空（全无标题/全重复/候选窗口恰在两轮间变动）时 t.skip——宿主环境
  // 不满足前提不是被测系统的缺陷。
  const countBy = (windows) => {
    const m = new Map()
    for (const w of windows) {
      if (!w.title) continue
      const k = w.pid + '|' + w.title
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }
  const c1 = countBy(l1.windows)
  const c2 = countBy(l2.windows)
  const comparable = new Map(
    l1.windows
      .filter((w) => {
        if (!w.title) return false
        const k = w.pid + '|' + w.title
        return c1.get(k) === 1 && c2.get(k) === 1
      })
      .map((w) => [w.pid + '|' + w.title, w]),
  )
  if (comparable.size === 0) {
    return t.skip('宿主无可比较的唯一标题窗口（全部无标题/标题重复/候选窗变动）——稳定性断言跳过')
  }
  let checked = 0
  for (const w of l2.windows) {
    if (!w.title) continue
    const k = w.pid + '|' + w.title
    const prev = comparable.get(k)
    if (!prev) continue
    assert.equal(w.windowId, prev.windowId, '唯一标题窗口的 windowId 必须沿用')
    checked += 1
  }
  assert.ok(checked >= 1, '可比较键存在却一个都没比上（checked=' + checked + '）——listWindows 输出形状异常')
})

test('real-driver: snapshot 对已列窗口返回声明 shape（QA FIX-7，只读）', async (t) => {
  if (process.platform !== 'darwin') return t.skip('非 darwin 平台')
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  t.after(() => { try { closeAll(build.binary) } catch { /* noop */ } })

  const l1 = await call(build.binary, 'listWindows', {}, 15000)
  if (!l1.windows.length) return t.skip('当前宿主无可列窗口（AX 未授权或无 GUI 窗口）——形状断言跳过')
  const target = l1.windows[0]
  const snap = await call(build.binary, 'snapshot', { windowId: target.windowId }, 15000)
  assert.equal(snap.windowId, target.windowId)
  assert.equal(typeof snap.pid, 'number')
  assert.equal(typeof snap.nodeCount, 'number')
  assert.ok(Array.isArray(snap.nodes), 'snapshot 必须带 nodes 数组（声明 shape）')
})

test('real-driver: 伪造/异 nonce 句柄 → 稳定错误码 + recovery 字段（QA FIX-7，只读）', async (t) => {
  if (process.platform !== 'darwin') return t.skip('非 darwin 平台')
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  t.after(() => { try { closeAll(build.binary) } catch { /* noop */ } })

  // 同 nonce 未知序号 → WINDOW_UNKNOWN；异 nonce → WINDOW_SESSION_EXPIRED。
  const ping = await call(build.binary, 'ping', {}, 15000)
  const nonce = String(ping.nonce ?? '')
  assert.ok(nonce, 'driver ping 必须回 nonce')

  const unknown = await call(build.binary, 'snapshot', { windowId: `win_${nonce}_99999` }, 15000)
    .then(() => { throw new Error('伪造句柄应当失败') },
      (err) => String(err.message))
  assert.match(unknown, /\[WINDOW_UNKNOWN\]/)
  assert.match(unknown, /recovery/, '错误信封必须带 recovery（session 层折进 message）')

  const expired = await call(build.binary, 'snapshot', { windowId: 'win_zzzzzz_1' }, 15000)
    .then(() => { throw new Error('异 nonce 句柄应当失败') },
      (err) => String(err.message))
  assert.match(expired, /\[WINDOW_SESSION_EXPIRED\]/)
  assert.match(expired, /recovery/)
})

test('real-driver: Tier-2 权限 gate 拒绝应答的 id 必须与请求配对（QA 终轮 P1）', async (t) => {
  if (process.platform !== 'darwin') return t.skip('非 darwin 平台')
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  // 权限强制拒绝钩子（driver 内测试钩子；仅本测试进程的子进程生效）。
  // 注：driver-build 的编译与此无关——env 影响的是运行中的 driver 进程。
  const { spawn } = await import('node:child_process')
  const result = await new Promise((resolve, reject) => {
    const child = spawn(build.binary, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, POST_EVENT_DENIED_FOR_TEST: '1' },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    child.stdin.end(JSON.stringify({ id: 42, op: 'key', args: { combo: 'return' } }) + '\n')
    // gate 拒绝应答应立即返回；给 5s 兜底。
    setTimeout(() => { try { child.kill() } catch { /* */ } reject(new Error('gate 拒绝应答超时——信封 id 未与请求配对（应答被 session 层丢弃）')) }, 5000)
    child.stdout.on('end', () => {
      try {
        const line = out.trim().split('\n').find((l) => l.includes('"id":42'))
        resolve(line ? JSON.parse(line) : null)
      } catch (e) { reject(e) }
    })
  })
  assert.ok(result, '必须收到 id=42 的拒绝应答（而不是超时/无应答）')
  assert.equal(result.id, 42, '应答 id 必须与请求 id 配对')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INPUT_POST_ACCESS_DENIED')
  assert.ok(result.recovery, '拒绝必须带 recovery 指引')
})
