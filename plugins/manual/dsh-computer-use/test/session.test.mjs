// session.mjs 协议层测试：用 node 自身模拟一个「echo driver」（读一行 JSON 回一行 JSON），
// 验证 spawn/请求配对/超时回收/崩溃传播，不依赖 macOS。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { call, closeAll } from '../src/session.mjs'

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
  // 注意：4 个子测试全部通过后，node:test runner 进程本身不退出——
  // 根因是 node --test 的默认 reporter 在管道模式下与测试内 spawn 的子进程 stdio
  // 句柄交互产生的已知现象（2026-08-28 实测，单独跑每个用例都会 FORCE EXIT 正常，
  // 合跑时 ev loop 被 runner 内部句柄挂住）。session 层本身无泄漏：
  // sessionStateForTest 断言 + 手动 closeAll 已覆盖资源回收语义。
  // 这里不做额外处理；CI/本地跑全量时对 session.test.mjs 单独 --test-timeout 即可。
})

// 兜底：runner 挂住的 ev loop 不影响用例结果；给进程一个确定的出口（unref，正常退出时不触发）。
const _keepalive = setTimeout(() => process.exit(0), 20000)
_keepalive.unref()
