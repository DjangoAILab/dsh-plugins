// session.mjs 协议层测试：用 node 自身模拟一个「echo driver」（读一行 JSON 回一行 JSON），
// 验证 spawn/请求配对/超时回收/崩溃传播，不依赖 macOS。
// 2026-08-31 扩展：stdin EPIPE、迟到退出不误删新会话、SIGTERM→SIGKILL 升级、写背压、
// 畸形应答行与未知 id 忽略；round-2（F6/F7/F11）：closeAll 不跳过 SIGKILL 升级、
// drain 闸门超时判死会话、闸门响应 abort、去掉兜底 process.exit（node --test 自然退出）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execPath } from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { call, closeAll, sessionStateForTest } from '../src/session.mjs'

// 用数组 join 构造脚本：模板字符串里手写的 '\n' 转义在嵌套脚本里极易写错
// （2026-08-28 踩坑：嵌套脚本语法错 → spawn EACCES/exited code 1 的迷惑现场）。
const ECHO_DRIVER = [
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
  "    if (req.op === 'boom') { console.error('kaboom'); process.exit(3) }",
  "    if (req.op === 'slow') { setTimeout(() => {",
  "      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { late: true } }) + '\\n')",
  '    }, 5000); continue }',
  "    if (req.op === 'fail') {",
  "      process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'op failed on purpose' }) + '\\n'); continue",
  '    }',
  "    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { echo: req.op, args: req.args } }) + '\\n')",
  '  }',
  '})',
  '',
].join('\n')

function makeFakeDriver(t) {
  const dir = mkdtempSync(join(tmpdir(), 'axdrv-test-'))
  const binary = join(dir, 'fake-driver.mjs')
  writeFileSync(binary, ECHO_DRIVER, { mode: 0o755 })
  return binary
}

// 以下新 driver 复用同一 makeScript 工厂（目录唯一，供 pgrep -f 精确匹配进程）。
function makeScript(t, lines, name = 'fake-driver.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'axdrv-test2-'))
  const binary = join(dir, name)
  writeFileSync(binary, lines.join('\n'), { mode: 0o755 })
  t.after(() => { try { closeAll(binary) } catch { /* noop */ } })
  return { dir, binary }
}

// 拿到该 fake driver 目录下当前存活的 pid 列表（pgrep -f 匹配完整命令行）。
function pidsOf(dir) {
  try {
    const out = execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
  } catch {
    return [] // pgrep 无匹配时非零退出
  }
}

test('session: request/response pairing with args echo', async () => {
  const binary = makeFakeDriver()
  try {
    const r1 = await call(binary, 'ping', undefined, 5000)
    assert.deepEqual(r1, { echo: 'ping' })
    const r2 = await call(binary, 'listWindows', { pid: 7 }, 5000)
    assert.deepEqual(r2, { echo: 'listWindows', args: { pid: 7 } })
    const r3 = await call(binary, 'x', undefined, 5000)
    assert.deepEqual(r3, { echo: 'x' })
  } finally {
    closeAll(binary)
  }
})

test('session: driver error reply rejects with message', async () => {
  const binary = makeFakeDriver()
  try {
    await assert.rejects(() => call(binary, 'fail', undefined, 5000), /op failed on purpose/)
  } finally {
    closeAll(binary)
  }
})

test('session: timeout rejects and recycles session (next call gets fresh process)', async () => {
  const binary = makeFakeDriver()
  try {
    await assert.rejects(() => call(binary, 'slow', undefined, 300), /timeout/)
    // 旧进程已被回收：下一次普通调用应正常（新进程）。
    const r = await call(binary, 'ping', undefined, 5000)
    assert.equal(r.echo, 'ping')
  } finally {
    closeAll(binary)
  }
})

test('session: driver crash surfaces stderr tail in error', async () => {
  const binary = makeFakeDriver()
  try {
    await assert.rejects(() => call(binary, 'boom', undefined, 5000), (err) => {
      const msg = String(err && err.message)
      return /driver exited|session closed/.test(msg)
    })
  } finally {
    closeAll()
  }
  // F7：测试文件不再有兜底 process.exit(0)——所有会话经 closeAll 回收、kill 升级定时器
  // unref（不挂事件循环）、子进程被回收后 stdio 句柄关闭，node --test 必须能自然退出。
})

// ---- 2026-08-31 扩展（B1-B5 对应的回归防线） ----

test('session: driver 已死后再写 → EPIPE 路由进 pending reject，不炸宿主', async (t) => {
  // die-on-start driver：spawn 后立刻退出。acquire 与 write 之间进程已死 →
  // write 打在死管道上（EPIPE）或 entry 已 closed。无论走哪条路径都必须：
  // ①call() 以可读错误拒绝 ②会话被回收 ③不产生 unhandled 'error' 事件（缺 B1
  // 处理器时 EPIPE 会直接带崩 runner，node:test 会把宿主进程的非零退出记为失败）。
  const { binary } = makeScript(t, [
    '#!/usr/bin/env node',
    'process.exit(0)',
    '',
  ])
  try {
    await assert.rejects(() => call(binary, 'ping', undefined, 5000), /stdin|closed|exited/)
    assert.equal(sessionStateForTest().count, 0, '会话必须被回收')
  } finally {
    closeAll(binary)
  }
})

test('session: SIGTERM 被忽略的 driver 在宽限后被 SIGKILL；迟到退出不误删新会话', async (t) => {
  const { dir, binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => { /* 忽略：模拟卡死 driver（SIGKILL 不可捕获，升级必杀） */ });",
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { buf += d; let nl;",
    "  while ((nl = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
    '    if (!line) continue;',
    "    let req; try { req = JSON.parse(line) } catch { continue }",
    "    if (req.op === 'hang') continue // 永不回复 → 触发超时",
    "    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { echo: req.op } }) + '\\n')",
    '  } })',
    '',
  ])
  await call(binary, 'ping', undefined, 5000)
  const oldPids = pidsOf(dir)
  assert.equal(oldPids.length, 1, '预热后恰好一个 driver 进程')
  // 超时回收：SIGTERM 发出但被忽略，旧进程此时仍活着。
  await assert.rejects(() => call(binary, 'hang', undefined, 200), /timeout/)
  assert.equal(pidsOf(dir).length, 1, 'SIGTERM 被忽略后进程仍在（宽限期内）')
  // 立刻建新会话（同一 binary 路径 → 新 entry 登记进 map）。
  const fresh = await call(binary, 'ping', undefined, 5000)
  assert.equal(fresh.echo, 'ping')
  assert.equal(sessionStateForTest().count, 1)
  // 宽限（1500ms）后旧进程必须被 SIGKILL；其迟到 'exit' 不得删掉新会话（B3）。
  await new Promise((r) => setTimeout(r, 2500))
  const alive = pidsOf(dir)
  assert.equal(alive.length, 1, '旧进程已被 SIGKILL，只剩新会话进程')
  assert.notEqual(alive[0], oldPids[0], '存活的是新进程')
  assert.equal(sessionStateForTest().count, 1, '迟到退出后新会话仍在')
  const again = await call(binary, 'ping', undefined, 5000)
  assert.equal(again.echo, 'ping')
})

test('session: closeAll 后忽略 SIGTERM 的 driver 在宽限期内被 SIGKILL（F6：升级定时器不随 map 清除）', async (t) => {
  const { dir, binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => { /* 忽略：模拟卡死 driver（SIGKILL 不可捕获，升级必杀） */ });",
    "setInterval(() => {}, 1 << 30);", // 挂住事件循环：不回收就永不退出
    "process.stdout.write(JSON.stringify({ id: 1, ok: true, result: { ready: true } }) + '\\n');",
    '',
  ])
  await call(binary, 'ping', undefined, 5000)
  const before = pidsOf(dir)
  assert.equal(before.length, 1, '预热后恰好一个 driver 进程')
  closeAll(binary)
  assert.equal(sessionStateForTest().count, 0, 'closeAll 后会话立即移出 map')
  // 宽限期（1500ms）内：SIGTERM 被忽略，进程必须还在——但升级定时器不得被 closeAll 清掉。
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(pidsOf(dir).length, 1, '宽限期内 SIGTERM 被忽略的进程仍在（未被 closeAll 跳过升级）')
  // 宽限期后必须收到 SIGKILL——closeAll 清空 map 也不能让卡死 driver 泄漏（F6 修复点）。
  await new Promise((r) => setTimeout(r, 1600))
  assert.equal(pidsOf(dir).length, 0, '忽略 SIGTERM 的 driver 在宽限后被 SIGKILL')
})

test('session: 写背压 — 管道满时后续请求等 drain 后照常送达（不挂起、不丢）', async (t) => {
  const { binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    'process.stdin.pause();', // 先不读：制造背压（>64KB 管道缓冲）
    'setTimeout(() => { process.stdin.resume() }, 400);',
    "process.stdin.on('data', (d) => { buf += d; let nl;",
    "  while ((nl = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
    '    if (!line) continue;',
    "    let req; try { req = JSON.parse(line) } catch { continue }",
    "    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { echo: req.op, size: JSON.stringify(req.args || {}).length } }) + '\\n')",
    '  } })',
    '',
  ])
  try {
    const big = 'x'.repeat(512 * 1024) // 512KB ≫ 64KB 管道缓冲 → write 返回 false
    const [r1, r2] = await Promise.all([
      call(binary, 'big', { blob: big }, 8000),
      call(binary, 'small', undefined, 8000),
    ])
    assert.equal(r1.echo, 'big')
    assert.equal(r1.size, JSON.stringify({ blob: big }).length, '大载荷无损送达')
    assert.equal(r2.echo, 'small')
  } finally {
    closeAll(binary)
  }
})

test('session: drain 闸门超时判死会话（F11：从不排空的 driver 不留连环超时）', async (t) => {
  const { dir, binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "process.stdin.pause();", // 永不读取：背压永不排空
    "setInterval(() => {}, 1 << 30);",
    "process.stdout.write(JSON.stringify({ id: 1, ok: true, result: { ready: true } }) + '\\n');",
    '',
  ])
  await call(binary, 'ping', undefined, 5000)
  const big = 'x'.repeat(512 * 1024) // ≫ 64KB 管道缓冲 → write 返回 false，闸门挂起
  const bigCall = call(binary, 'big', { blob: big }, 8000)
  bigCall.catch(() => {}) // 本用例聚焦 small 闸门超时；big 的拒绝由 closeAll/killEntry 收口
  await new Promise((r) => setTimeout(r, 50)) // 等 big 写完并进入背压
  const started = Date.now()
  // 闸门预算 300ms：超时必须拒绝且判死会话（killEntry），而不是把坏会话留给下一条请求。
  await assert.rejects(() => call(binary, 'small', undefined, 300), /背压未排空/)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, '闸门超时应按预算（300ms）拒绝，实际 ' + elapsed + 'ms')
  assert.equal(sessionStateForTest().count, 0, '闸门超时后会话必须被回收')
  // 会话判死 → SIGTERM →（默认处理器）进程退出，stdio 句柄关闭，事件循环可自然排空。
  for (let i = 0; i < 20 && pidsOf(dir).length > 0; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(pidsOf(dir).length, 0, '被闸门超时判死的 driver 进程必须退出')
})

test('session: drain 闸门响应 abort — 中止后立刻拒绝且不写（F11）', async (t) => {
  const { binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "process.stdin.pause();",
    "setInterval(() => {}, 1 << 30);",
    "process.stdout.write(JSON.stringify({ id: 1, ok: true, result: { ready: true } }) + '\\n');",
    '',
  ])
  await call(binary, 'ping', undefined, 5000)
  const big = 'x'.repeat(512 * 1024)
  const bigCall = call(binary, 'big', { blob: big }, 8000)
  bigCall.catch(() => {})
  await new Promise((r) => setTimeout(r, 50)) // 等 big 进入背压（entry.draining 挂起）
  const ac = new AbortController()
  const smallPromise = assert.rejects(
    () => call(binary, 'small', undefined, 8000, { signal: ac.signal }),
    /aborted during drain/,
  )
  await new Promise((r) => setTimeout(r, 50)) // 等 small 进入 drain 闸门
  ac.abort()
  await smallPromise
})

test('session: 畸形应答行与未知 id 的应答被忽略，正常应答不受影响', async (t) => {
  const { binary } = makeScript(t, [
    '#!/usr/bin/env node',
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { buf += d; let nl;",
    "  while ((nl = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
    '    if (!line) continue;',
    "    let req; try { req = JSON.parse(line) } catch { continue }",
    "    process.stdout.write('this is not json\\n');", // 畸形行
    "    process.stdout.write(JSON.stringify({ id: 424242, ok: true, result: { stray: true } }) + '\\n');", // 未知 id
    "    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { echo: req.op } }) + '\\n')",
    '  } })',
    '',
  ])
  try {
    const r = await call(binary, 'ping', undefined, 5000)
    assert.equal(r.echo, 'ping')
    assert.equal('stray' in r, false)
  } finally {
    closeAll(binary)
  }
})
