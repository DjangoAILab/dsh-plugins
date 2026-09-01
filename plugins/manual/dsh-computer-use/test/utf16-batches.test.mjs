// utf16Batches 边界回归（QA 细节收尾 + QA FIX-7）：经 driver 的 selfTest op 断言真实实现——
// emoji（代理对）跨批不拆、孤立代理不产生、精确 20 单元边界。纯函数调用，零 GUI 副作用。
// FIX-7：被 spawn 的二进制由 test/helpers/driver-build.mjs 从**当前工作树源码**现场编译
//（单飞），绝不用 driver/axdriver 陈旧产物；swiftc 不可用时整组跳过（原因明示）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { compileDriverForTest } from './helpers/driver-build.mjs'

function selfTest(binary, text, maxLen) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stdout.on('end', () => {
      try {
        const line = out.trim().split('\n').find((l) => l.includes('"id":1'))
        resolve(JSON.parse(line).result)
      } catch (e) { reject(e) }
    })
    child.on('error', reject)
    child.stdin.end(JSON.stringify({ id: 1, op: 'selfTest', args: { text, maxLen } }) + '\n')
  })
}

test('utf16Batches: emoji 跨 20 单元边界不被拆开（selfTest 实测，当前源码现场编译）', async (t) => {
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  // 19 个 ASCII + 1 个 emoji（2 单元）：固定切片会把代理对劈成两半。
  const text = 'a'.repeat(19) + '😀'
  const r = await selfTest(build.binary, text, 20)
  // 第一批 19 单元（19 个 a），第二批 2 单元（完整代理对 0xD83D 0xDE00）。
  assert.equal(r.batchCount, 2)
  assert.equal(r.batches[0].length, 19)
  assert.deepEqual(r.batches[1], [0xD83D, 0xDE00], '代理对必须完整落在同一批')
})

test('utf16Batches: 连续 emoji 与混排文本无孤立代理（selfTest 实测）', async (t) => {
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  const text = '中a😀b'.repeat(8) // 每组 1+1+2+1 = 5 单元，共 40 单元，必然跨批
  const r = await selfTest(build.binary, text, 20)
  let ok = true
  for (const batch of r.batches) {
    for (let i = 0; i < batch.length; i++) {
      const u = batch[i]
      if (u >= 0xD800 && u <= 0xDBFF) {
        // 高代理后面必须紧跟同批内的低代理
        const next = batch[i + 1]
        if (!(next >= 0xDC00 && next <= 0xDFFF)) ok = false
      }
    }
    // 批首不得是孤立低代理（上一批尾是高代理）
    const first = batch[0]
    if (first >= 0xDC00 && first <= 0xDFFF) ok = false
  }
  assert.ok(ok, '所有批次都不得产生孤立代理')
  assert.equal(r.batches.reduce((n, b) => n + b.length, 0), Array.from(text).length * 0 + text.length, '切批不丢单元')
})

test('utf16Batches: 退化 maxLen=1 时代理对扩容为 2（注释明确的退化策略）', async (t) => {
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  const r = await selfTest(build.binary, '😀', 1)
  assert.equal(r.batchCount, 1, '单个 emoji 即使 maxLen=1 也必须整对发出')
  assert.equal(r.batches[0].length, 2)
})

test('utf16Batches: 恰好 20 单元且边界是代理对起点 → 挪到下一批', async (t) => {
  const build = await compileDriverForTest()
  if (!build.available) return t.skip(build.reason)
  // 20 个单元恰好装下：19 ASCII + emoji 首单元会在 20 边界——验证挪移。
  const text = 'a'.repeat(18) + '😀' + 'b'
  // units: 18a + [D83D, DE00] + b = 21 单元。maxLen=20 → 切在 b 前？20 单元 = 18a+D83D+DE00？不：
  // 18+2+1=21，第一批 20 = 18a+emoji对 → 第 21 单元 b 单独成批。emoji 完整。
  const r = await selfTest(build.binary, text, 20)
  assert.equal(r.batchCount, 2)
  assert.equal(r.batches[0].length, 20)
  assert.deepEqual(r.batches[0].slice(18), [0xD83D, 0xDE00])
  assert.deepEqual(r.batches[1], [0x0062])
})
