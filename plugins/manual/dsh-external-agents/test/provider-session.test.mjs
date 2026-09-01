// v2.5.1 回归：provider 的 claude 分支按 freshSession 标志选择 --session-id/--resume（不按 id 相等性）。
// 0.5.0 首版按 id 相等性判断，resume 时传入的 id 与「新 id」相同导致误判成 --session-id，实测报
// "Session ID already in use"（回归验收抓到）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCliProvider } from '../src/provider.mjs'

function makeFakeCtx() {
  const captured = []
  return {
    ctx: {
      logger: { warn() {}, info() {} },
      subprocess: {
        async resolveExecutable(cmd) { return '/usr/bin/true-' + cmd },
        spawn(spec) {
          captured.push(spec.argv)
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0 }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) } },
            terminate() {},
            async waitForExit() {},
          }
        },
      },
    },
    captured,
  }
}

const CLAUDE_SESSION = { resumeArg: '--resume', newSessionArg: '--session-id' }
const CONFIG = { command: 'claude', args: ['--print', '--output-format', 'text'], env: {} }
const PARENT = { session: { header: { cwd: '/tmp' } } }
const SID = '04015337-4e68-4498-b3b4-3dc75095fe71'

test('v2.5.1：resume（sessionId + freshSession=false）必须走 --resume 而非 --session-id', async () => {
  const { ctx, captured } = makeFakeCtx()
  const provider = createCliProvider({ ctx, name: 'external:claude', config: CONFIG, claudeSession: CLAUDE_SESSION, graceMs: 100, maxOutputBytes: 4096 })
  const run = await provider.start({ label: 't', prompt: [{ type: 'text', text: 'x' }], parent: PARENT, sessionId: SID, freshSession: false, signal: new AbortController().signal })
  await run.result
  run.dispose()
  const argv = captured[0]
  assert.equal(argv[argv.indexOf('--resume') + 1], SID, '--resume carries the passed id')
  assert.ok(!argv.includes('--session-id'), 'must NOT use --session-id for resume')
  assert.equal(run.result ? true : false, true)
})

test('v2.5.1：fresh（freshSession=true + 预生成 id）必须走 --session-id', async () => {
  const { ctx, captured } = makeFakeCtx()
  const provider = createCliProvider({ ctx, name: 'external:claude', config: CONFIG, claudeSession: CLAUDE_SESSION, graceMs: 100, maxOutputBytes: 4096 })
  const run = await provider.start({ label: 't', prompt: [{ type: 'text', text: 'x' }], parent: PARENT, sessionId: SID, freshSession: true, signal: new AbortController().signal })
  await run.result
  run.dispose()
  const argv = captured[0]
  assert.equal(argv[argv.indexOf('--session-id') + 1], SID, '--session-id carries the pre-generated id')
  assert.ok(!argv.includes('--resume'), 'must NOT use --resume for fresh session')
})

test('v2.5.1：无 sessionId 的 claude 调用自动生成新 UUID 走 --session-id', async () => {
  const { ctx, captured } = makeFakeCtx()
  const provider = createCliProvider({ ctx, name: 'external:claude', config: CONFIG, claudeSession: CLAUDE_SESSION, graceMs: 100, maxOutputBytes: 4096 })
  const run = await provider.start({ label: 't', prompt: [{ type: 'text', text: 'x' }], parent: PARENT, signal: new AbortController().signal })
  const res = await run.result
  run.dispose()
  const argv = captured[0]
  assert.equal(argv[argv.indexOf('--session-id') + 1], res.sessionId, 'generated id is surfaced in result')
  assert.match(res.sessionId, /^[0-9a-f-]{36}$/)
})
