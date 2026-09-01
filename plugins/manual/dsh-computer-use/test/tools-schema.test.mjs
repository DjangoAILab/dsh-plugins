// tools.mjs 两层输出契约测试（D1，v0.2.0 协议）：
//   ①register-capture harness：mock ctx.tools.register 收集全部工具定义；
//   ②stub driver：读行 JSON 请求、按 op 回应「历史上出过问题的形状」（hidden/null bundleId/
//     null axWindows、带/不带 hint、带/不带 frontApp、truncatedNodes、条件性 windowId…）；
//   ③对每个工具：跑 execute()，断言 validateJsonSchemaValue(def.output.schema, result)
//     无 violation，且结果树里不存在 undefined 值（run_code 要求无损 JSON）。
//
// v0.2.0：stub driver 说新协议（listWindows 签发 windowId / snapshot{windowId} /
// windowAction / resolveCapture / mode+delivery）；computer_screenshot 不在此执行
// （会跑真 screencapture 截真屏幕），其 schema 用样例值直接验证。
// registry 行为（句柄沿用/tombstone/前台纪律）在 test/window-registry.test.mjs 用
// 有状态 stub 覆盖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/config.mjs'
import { mountComputerTools } from '../src/tools.mjs'
import { closeAll } from '../src/session.mjs'
import { GUIDANCE } from '../src/doctor.mjs'

// 用数组 join 构造脚本（嵌套脚本里手写 '\n' 转义易错，见 session.test.mjs 2026-08-28 踩坑）。
const STUB_DRIVER = [
  '#!/usr/bin/env node',
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
  'function win(o) { return Object.assign({ windowId: o.windowId, pid: o.pid, appName: o.appName },',
  '  o.title !== undefined ? { title: o.title } : {},',
  '  o.frame !== undefined ? { frame: o.frame } : {},',
  '  o.minimized !== undefined ? { minimized: o.minimized } : {},',
  '  o.main !== undefined ? { main: o.main } : {},',
  '  o.captureAvailable !== undefined ? { captureAvailable: o.captureAvailable } : {}) }',
  'function handle(req) {',
  '  const a = req.args || {};',
  '  switch (req.op) {',
  '    case "doctor": {',
  '      if (process.env.STUB_DOCTOR_MODE === "silent") return;',
  '      if (process.env.STUB_DOCTOR_MODE === "error") { send({ id: req.id, ok: false, error: "stub driver error" }); return }',
  '      const out = { axTrusted: true, osVersion: "stub-OS", screenCapture: process.env.STUB_DOCTOR_SCREEN !== "no", postEventAccess: process.env.STUB_DOCTOR_POST !== "no" };',
  '      if (process.env.STUB_DOCTOR_MODE !== "nofront") out.frontApp = { pid: 42, name: "TextEdit" };',
  '      send({ id: req.id, ok: true, result: out }); return;',
  '    }',
  '    case "listApps":',
  '      send({ id: req.id, ok: true, result: { apps: [',
  '        { pid: 100, name: "TextEdit", bundleId: "com.apple.TextEdit", frontmost: true, hidden: false, axWindows: 1 },',
  '        { pid: 200, name: "Broken", bundleId: null, frontmost: false, hidden: true, axWindows: null },',
  '        { pid: 300, name: "NoExtras", frontmost: false }',
  '      ] } }); return;',
  '    case "listWindows":',
  '      if (a.pid === 7) { send({ id: req.id, ok: true, result: { windows: [], hint: "app 暂未响应 AX 请求（transient，stub）" } }); return }',
  '      if (a.pid === 999) { send({ id: req.id, ok: false, error: "app 暂未响应 AX 请求", code: "WINDOW_TRANSIENT", retryable: true, recovery: "稍等重试" }); return }',
  '      send({ id: req.id, ok: true, result: { windows: [',
  '        win({ windowId: "win_stub_1", pid: 8, appName: "Edit", title: "Doc", frame: { x: 0, y: 0, width: 800, height: 600 }, minimized: false, main: true, captureAvailable: true }),',
  '        win({ windowId: "win_stub_2", pid: 9, appName: "Zed", minimized: true, captureAvailable: false })',
  '      ] } }); return;',
  '    case "snapshot":',
  '      if (a.windowId === "win_stub_2") { send({ id: req.id, ok: true, result: { windowId: a.windowId, pid: 9, nodeCount: 0, nodes: [], title: "Empty" } }); return }',
  '      send({ id: req.id, ok: true, result: { windowId: a.windowId, pid: 8, nodeCount: 2, title: "Main",',
  '        frame: { x: 10, y: 20, width: 800, height: 600 }, truncatedNodes: 2,',
  '        nodes: [',
  '          { ref: "@0", depth: 0, role: "AXWindow", title: "Main", frame: { x: 10, y: 20, width: 800, height: 600 }, focused: true, actions: ["AXPress"], value: null },',
  '          { ref: "@0/0", depth: 1, role: "AXButton", title: "OK" }',
  '        ] } }); return;',
  '    case "windowAction":',
  '      if (a.windowId === "win_stub_gone") { send({ id: req.id, ok: false, error: "窗口已关闭", code: "WINDOW_GONE", retryable: false, recovery: "computer_windows 重新获取句柄" }); return }',
  '      send({ id: req.id, ok: true, result: { windowId: a.windowId, verb: a.verb, ok: true, title: "Doc", frame: { x: 1, y: 2, width: 800, height: 600 }, minimized: a.verb === "minimize" } }); return;',
  '    case "resolveCapture":',
  '      if (a.windowId === "win_stub_amb") { send({ id: req.id, ok: false, error: "2 个 frame 相符 CG 窗口", code: "WINDOW_CAPTURE_AMBIGUOUS", retryable: false, recovery: "computer_window activate" }); return }',
  '      if (a.windowId === "win_stub_gone") { send({ id: req.id, ok: false, error: "窗口已关闭", code: "WINDOW_GONE", retryable: false, recovery: "computer_windows 重新获取句柄" }); return }',
  '      send({ id: req.id, ok: true, result: { windowId: a.windowId, cgWindowNumber: 4242 } }); return;',
  '    case "click":',
  '      if (a.ref) { send({ id: req.id, ok: true, result: { mode: "ax-action", delivery: "acknowledged", windowId: a.windowId, ref: a.ref, action: a.action || "AXPress" } }); return }',
  '      send({ id: req.id, ok: true, result: { mode: "global-cgevent", delivery: "posted-unverified", x: a.x, y: a.y } }); return;',
  '    case "type":',
  '      if (a.ref) { send({ id: req.id, ok: true, result: { mode: "ax-value", delivery: "acknowledged", windowId: a.windowId, ref: a.ref, length: (a.text || "").length } }); return }',
  '      send({ id: req.id, ok: true, result: { mode: "global-cgevent", delivery: "posted-unverified", length: (a.text || "").length } }); return;',
  '    case "key":',
  '      send({ id: req.id, ok: true, result: { combo: a.combo, planned: true, mode: "global-cgevent", delivery: "posted-unverified" } }); return;',
  '    case "scroll":',
  '      send({ id: req.id, ok: true, result: { dx: a.dx, dy: a.dy, mode: "global-cgevent", delivery: "posted-unverified" } }); return;',
  '    case "menu":',
  '      send({ id: req.id, ok: true, result: { ok: true, path: a.path } }); return;',
  '    case "app":',
  '      if (a.verb === "quit") { send({ id: req.id, ok: true, result: { verb: "quit", pid: a.pid, requested: true, accepted: true } }); return }',
  '      send({ id: req.id, ok: true, result: { verb: "launch", bundleId: a.bundleId } }); return;',
  '    default:',
  '      send({ id: req.id, ok: false, error: "stub unknown op: " + req.op });',
  '  }',
  '}',
  '',
].join('\n')

function makeFixtureDir(t, { doctorSource = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'axstub-test-'))
  const binary = join(dir, 'axdriver')
  writeFileSync(binary, STUB_DRIVER, { mode: 0o755 })
  if (doctorSource) {
    // doctor 的 ensureDriverCompiled 需要源码存在且不比产物新——写 dummy 源码并把
    // mtime 拨老 10s，让编译检查直接跳过（stub 脚本就是「编译产物」）。
    const source = join(dir, 'axdriver.swift')
    writeFileSync(source, '// stub source（schema 测试不需要真 Swift）')
    const now = new Date()
    const past = new Date(now.getTime() - 10_000)
    utimesSync(source, past, past)
    utimesSync(binary, now, now)
  }
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  return dir
}

function makeHarness(cfgOverrides = {}) {
  const registered = []
  const ctx = {
    tools: { register: (def) => { registered.push(def) } },
    effect: () => () => {},
    get: () => undefined,
  }
  const cfg = resolveConfig(cfgOverrides)
  mountComputerTools(ctx, cfg)
  const byName = new Map(registered.map((d) => [d.name, d]))
  return { registered, byName, cfg }
}

const EXEC = { agent: {} }

/** 无损 JSON 检查：递归断言没有 undefined 值（JSON round-trip 察觉不了 undefined 丢失）。 */
function assertNoUndefined(value, path = 'result') {
  if (value === undefined) throw new Error('lossless JSON 违规：' + path + ' 是 undefined')
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, path + '[' + i + ']'))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, path + '.' + k)
  }
}

/** DSH enforced JSON-Schema 子集：type 必须是单字符串（type 数组会被运行时拒绝）。 */
function assertSingleStringTypes(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object') return
  if (schema.type !== undefined) {
    assert.equal(typeof schema.type, 'string', path + '.type 必须是单字符串')
  }
  for (const sub of Object.values(schema.properties ?? {})) assertSingleStringTypes(sub, path)
  if (schema.items) assertSingleStringTypes(schema.items, path + '.items')
}

async function assertExecuteValid(harness, toolName, args, check) {
  const def = harness.byName.get(toolName)
  assert.ok(def, '工具未注册: ' + toolName)
  assertSingleStringTypes(def.output.schema, toolName + '.output.schema')
  const result = await def.execute(args, EXEC)
  assertNoUndefined(result, toolName)
  const violations = validateJsonSchemaValue(def.output.schema, result)
  assert.deepEqual(violations, [], toolName + ' 输出违反自身 schema')
  if (check) check(result)
  return result
}

test('tools-schema: 每个工具定义都用了单字符串 type（enforced 子集）', (t) => {
  const dir = makeFixtureDir(t)
  const { registered } = makeHarness({ driverDir: dir })
  assert.equal(registered.length, 12, '12 个 computer_* 工具全注册（v0.2.0 新增 computer_window）')
  for (const def of registered) assertSingleStringTypes(def.output.schema, def.name)
})

test('tools-schema: computer_doctor — 正常应答（frontApp + screenCapture + postEventAccess）', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_doctor', {}, (r) => {
    assert.equal(r.supported, true)
    assert.equal(r.driverReady, true)
    assert.equal(r.axTrusted, true)
    assert.equal(r.screenCapture, true)
    // QA FIX-6：事件投递权限预检透传 + 渲染。
    assert.equal(r.postEventAccess, true)
    assert.equal(r.frontApp, 'TextEdit')
  })
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_doctor — 无 frontApp 且 screenCapture=false（渲染出屏幕录制指引）', async (t) => {
  const dir = makeFixtureDir(t)
  process.env.STUB_DOCTOR_MODE = 'nofront'
  process.env.STUB_DOCTOR_SCREEN = 'no'
  process.env.STUB_DOCTOR_POST = 'no'
  try {
    const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
    const r = await assertExecuteValid(h, 'computer_doctor', {}, (r) => {
      assert.equal(r.screenCapture, false)
      assert.equal(r.postEventAccess, false)
      assert.equal('frontApp' in r, false, 'frontApp 必须条件性缺席，不能 undefined/null')
    })
    const rendered = h.byName.get('computer_doctor').output.render({}, r)
    const text = rendered.map((c) => c.text).join('\n')
    assert.match(text, /NOT trusted/)
    assert.match(text, /post-event access: unavailable/, 'postEventAccess=false 必须渲染（QA FIX-6）')
    assert.ok(text.includes(GUIDANCE.screenRecording.split('\n')[0]), '渲染必须包含屏幕录制指引')
    closeAll(join(dir, 'axdriver'))
  } finally {
    delete process.env.STUB_DOCTOR_MODE
    delete process.env.STUB_DOCTOR_SCREEN
    delete process.env.STUB_DOCTOR_POST
  }
})

test('tools-schema: computer_doctor — probe 超时 → driverReady:false + driver 故障 reason', async (t) => {
  const dir = makeFixtureDir(t)
  process.env.STUB_DOCTOR_MODE = 'silent'
  try {
    const h = makeHarness({ driverDir: dir, commandTimeoutMs: 400 })
    const r = await assertExecuteValid(h, 'computer_doctor', {}, (r) => {
      assert.equal(r.driverReady, false)
      assert.match(r.reason, /timeout/)
    })
    const rendered = h.byName.get('computer_doctor').output.render({}, r)
    assert.match(rendered[0].text, /NOT READY/)
  } finally {
    delete process.env.STUB_DOCTOR_MODE
  }
})

test('tools-schema: computer_doctor — driver 错误应答 → driverReady:false + reason', async (t) => {
  const dir = makeFixtureDir(t)
  process.env.STUB_DOCTOR_MODE = 'error'
  try {
    const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
    await assertExecuteValid(h, 'computer_doctor', {}, (r) => {
      assert.equal(r.driverReady, false)
      assert.match(r.reason, /stub driver error/)
    })
  } finally {
    delete process.env.STUB_DOCTOR_MODE
  }
})

test('tools-schema: computer_list_apps — null bundleId/axWindows 归一化删除，hidden 进 schema', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_list_apps', {}, (r) => {
    assert.equal(r.apps.length, 3)
    assert.equal(r.apps[0].hidden, false)
    assert.equal('bundleId' in r.apps[1], false, 'null bundleId 必须删键')
    assert.equal('axWindows' in r.apps[1], false, 'null axWindows 必须删键')
    assert.equal(r.apps[1].hidden, true)
    assert.equal('hidden' in r.apps[2], false, '缺失字段不能造 undefined 占位')
    assert.equal('frontmost' in r.apps[2], true)
  })
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_windows — 新 shape（windowId/appName/frame 声明），hint 与错误信封', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  // transient hint 路径（pid=7 → 空 windows + hint）
  await assertExecuteValid(h, 'computer_windows', { pid: 7 }, (r) => {
    assert.ok(r.hint)
    assert.deepEqual(r.windows, [])
  })
  // 常规路径：pid 可选；省略 = 全部窗口（stub 同样应答）
  for (const args of [{ pid: 8 }, {}]) {
    await assertExecuteValid(h, 'computer_windows', args, (r) => {
      assert.equal('hint' in r, false, '无 hint 时不能有 undefined 占位')
      assert.equal(r.windows.length, 2)
      assert.equal(r.windows[0].windowId, 'win_stub_1')
      assert.equal(r.windows[0].appName, 'Edit')
      assert.deepEqual(r.windows[0].frame, { x: 0, y: 0, width: 800, height: 600 })
      assert.equal(r.windows[1].captureAvailable, false)
      assert.equal('title' in r.windows[1], false, 'null/缺 title 必须删键')
      assert.equal('frame' in r.windows[1], false, '缺 frame 必须删键')
    })
  }
  // 错误信封：code/retryable/recovery 折进 Error message（session 层契约）
  await assert.rejects(
    () => h.byName.get('computer_windows').execute({ pid: 999 }, EXEC),
    (err) => {
      const msg = String(err && err.message)
      return msg.includes('[WINDOW_TRANSIENT]') && msg.includes('retryable') && msg.includes('recovery')
    },
  )
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_snapshot — 窗口句柄寻址，精确 shape（lines 进 schema）', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  const r = await assertExecuteValid(h, 'computer_snapshot', { windowId: 'win_stub_1' }, (r) => {
    assert.equal(r.windowId, 'win_stub_1')
    assert.equal(r.pid, 8)
    assert.equal(r.nodeCount, 2)
    assert.equal(r.truncatedNodes, 2)
    assert.ok(Array.isArray(r.lines) && r.lines.length >= 3)
    assert.match(r.lines[0], /window win_stub_1 of pid=8/)
    assert.deepEqual(Object.keys(r).sort(),
      ['lines', 'nodeCount', 'pid', 'truncatedNodes', 'windowId'],
      'snapshot 输出必须是声明的五个键，不 spread driver 结果')
  })
  const rendered = h.byName.get('computer_snapshot').output.render({}, r)
  assert.match(rendered[0].text, /AXButton/)
  // 变体：无 truncatedNodes（空树）→ 键缺席
  const r2 = await assertExecuteValid(h, 'computer_snapshot', { windowId: 'win_stub_2' }, (r2) => {
    assert.equal('truncatedNodes' in r2, false)
    assert.match(r2.lines[1], /empty AX tree/)
  })
  assert.ok(r2)
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_window — 动作成功带 post-state', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_window', { windowId: 'win_stub_1', verb: 'activate' }, (r) => {
    assert.equal(r.ok, true)
    assert.equal(r.verb, 'activate')
    assert.equal(r.windowId, 'win_stub_1')
    assert.deepEqual(r.frame, { x: 1, y: 2, width: 800, height: 600 })
  })
  await assertExecuteValid(h, 'computer_window', { windowId: 'win_stub_1', verb: 'minimize' }, (r) => {
    assert.equal(r.minimized, true)
  })
  // move/resize 缺参在 JS 侧报错
  await assert.rejects(
    () => h.byName.get('computer_window').execute({ windowId: 'win_stub_1', verb: 'move' }, EXEC),
    /verb=move 需要 x\/y/,
  )
  // 错误信封透传
  await assert.rejects(
    () => h.byName.get('computer_window').execute({ windowId: 'win_stub_gone', verb: 'raise' }, EXEC),
    /\[WINDOW_GONE\]/,
  )
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_click — ref（Tier 0/ax-action）与坐标（Tier 2/global-cgevent）', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_click', { windowId: 'win_stub_1', ref: '@0/1' }, (r) => {
    assert.equal(r.mode, 'ax-action')
    assert.equal(r.delivery, 'acknowledged')
    assert.equal(r.ref, '@0/1')
    assert.equal(r.windowId, 'win_stub_1')
  })
  await assertExecuteValid(h, 'computer_click', { x: 10.5, y: 20.25 }, (r) => {
    assert.equal(r.mode, 'global-cgevent')
    assert.equal(r.delivery, 'posted-unverified')
    assert.equal('ref' in r, false)
  })
  // ref 不带 windowId：v0.2.0 clean break，JS 侧直接拒绝
  await assert.rejects(
    () => h.byName.get('computer_click').execute({ ref: '@0/1' }, EXEC),
    /\[INVALID_ARGUMENT\].*windowId/,
  )
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_type — ax-value 与 global-cgevent', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_type', { windowId: 'win_stub_1', text: 'hello', ref: '@0/0' }, (r) => {
    assert.equal(r.mode, 'ax-value')
    assert.equal(r.delivery, 'acknowledged')
    assert.equal(r.length, 5)
  })
  await assertExecuteValid(h, 'computer_type', { text: '你好' }, (r) => {
    assert.equal(r.mode, 'global-cgevent')
    assert.equal(r.delivery, 'posted-unverified')
    assert.equal('ref' in r, false)
  })
  await assert.rejects(
    () => h.byName.get('computer_type').execute({ text: 'x', ref: '@0' }, EXEC),
    /\[INVALID_ARGUMENT\].*windowId/,
  )
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_key / computer_scroll — mode+delivery 统一输出', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_key', { combo: 'cmd+s' }, (r) => {
    assert.equal(r.combo, 'cmd+s')
    assert.equal(r.planned, true)
    assert.equal(r.mode, 'global-cgevent')
    assert.equal(r.delivery, 'posted-unverified')
  })
  await assertExecuteValid(h, 'computer_key', { combo: 'cmd+s', windowId: 'win_stub_1' }, (r) => {
    assert.equal(r.windowId, 'win_stub_1')
  })
  await assertExecuteValid(h, 'computer_scroll', { dy: -3, dx: 0, windowId: 'win_stub_1' }, (r) => {
    assert.deepEqual([r.dx, r.dy], [0, -3])
    assert.equal(r.mode, 'global-cgevent')
    assert.equal(r.windowId, 'win_stub_1')
  })
  // 未知键名在 JS 侧报错（不产生无效 driver 请求）
  await assert.rejects(
    () => h.byName.get('computer_key').execute({ combo: 'cmd+retrun' }, EXEC),
    /未知按键名/,
  )
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_menu / computer_app — 保持 v0.1 行为', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  await assertExecuteValid(h, 'computer_menu', { pid: 8, path: ['文件', '新建'] }, (r) => {
    assert.deepEqual(r.path, ['文件', '新建'])
  })
  await assertExecuteValid(h, 'computer_app', { verb: 'launch', bundleId: 'com.apple.TextEdit' }, (r) => {
    assert.equal(r.verb, 'launch')
    assert.equal(r.bundleId, 'com.apple.TextEdit')
  })
  const quitResult = await assertExecuteValid(h, 'computer_app', { verb: 'quit', pid: 4 }, (r) => {
    // F5：requested=请求已发出（恒 true）；accepted=terminate() 返回值。两者独立上报。
    assert.equal(r.requested, true)
    assert.equal(r.accepted, true)
  })
  // F5 渲染：accepted=false（系统拒绝）时两个字段如实出现；accepted=true 不渲染拒绝文案。
  const appRender = h.byName.get('computer_app').output.render
  const deniedText = appRender({}, { verb: 'quit', pid: 4, requested: true, accepted: false })[0].text
  assert.match(deniedText, /requested=true/)
  assert.match(deniedText, /accepted=false/)
  const okText = appRender({}, quitResult)[0].text
  assert.doesNotMatch(okText, /拒绝/)
  closeAll(join(dir, 'axdriver'))
})

test('tools-schema: computer_screenshot — 不执行（会截真屏）；schema 样例验证 + 降采样插值', (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir })
  const def = h.byName.get('computer_screenshot')
  // C7：描述里的长边数字必须是 config 值（不再是拼接断掉的模板）
  assert.match(def.description, new RegExp('长边 ' + h.cfg.screenshotMaxDimension))
  // v0.2.0：window 模式 windowId-first（不再有 pid+windowIndex 截窗）
  assert.match(def.description, /windowId/)
  assert.doesNotMatch(def.description, /windowIndex/)
  const sampleAll = { path: '/tmp/shot.png', bytes: 1234, mode: 'all', downscaled: false }
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, sampleAll), [])
  const sampleWin = { path: '/tmp/shot2.png', bytes: 2048, mode: 'window', downscaled: true, windowId: 'win_stub_1' }
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, sampleWin), [])
  assertSingleStringTypes(def.output.schema, 'computer_screenshot.output.schema')
  // mode=window 缺 windowId 在 JS 侧拒绝（不发 driver 请求）
  return def.execute({ mode: 'window' }, EXEC).then(
    () => { throw new Error('应当拒绝') },
    (err) => { assert.match(String(err.message), /windowId/) },
  )
})

test('tools-schema: inputMode plumbing — cursorless/global 纪律（Tier 1 未实现，绝不静默降级）', async (t) => {
  const dir = makeFixtureDir(t)
  const h = makeHarness({ driverDir: dir, commandTimeoutMs: 5000 })
  // cursorless + Tier 0（ref 寻址）→ 放行
  await assertExecuteValid(h, 'computer_click', { windowId: 'win_stub_1', ref: '@0/1', inputMode: 'cursorless' }, (r) => {
    assert.equal(r.mode, 'ax-action')
  })
  // cursorless + Tier 2 路径（坐标/无 ref/键/滚动）→ INPUT_UNSUPPORTED
  for (const [tool, args] of [
    ['computer_click', { x: 1, y: 2, inputMode: 'cursorless' }],
    ['computer_type', { text: 'x', inputMode: 'cursorless' }],
    ['computer_key', { combo: 'return', inputMode: 'cursorless' }],
    ['computer_scroll', { dy: -1, inputMode: 'cursorless' }],
  ]) {
    await assert.rejects(
      () => h.byName.get(tool).execute(args, EXEC),
      /\[INPUT_UNSUPPORTED\]/,
      tool + ' cursorless 必须报 INPUT_UNSUPPORTED',
    )
  }
  // QA 终轮裁定：global+ref 允许——global 是「显式选择 Tier 2」，ref 元素 set 失败时按
  // 前台纪律降级为全局注入（driver 侧已实现）；不再按互斥拒绝。
  await assertExecuteValid(h, 'computer_click', { windowId: 'win_stub_1', ref: '@0/1', inputMode: 'global' }, (r) => {
    assert.equal(r.mode, 'ax-action') // click ref 走 Tier 0，inputMode 仅在降级时生效
  })
  // 非法值
  await assert.rejects(
    () => h.byName.get('computer_key').execute({ combo: 'return', inputMode: 'pid' }, EXEC),
    /inputMode 必须是/,
  )
  closeAll(join(dir, 'axdriver'))
})
