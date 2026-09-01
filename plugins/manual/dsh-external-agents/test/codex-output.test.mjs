// dsh-external-agents codex-output.mjs 单测（纯函数，无 ctx）
// 证据锚点：codex-cli 0.146.0 实测事件形态（2026-08-31）——升级 codex 后这些 fixture 需要用
// 真实输出复核（smoke：`echo hi | codex exec --json -`），防格式漂移悄悄破坏 session 连续性。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonlOutput, parseBannerSessionId, extractCodexOutput, isUuid, missingSessionIdReason, sessionFooter } from '../src/codex-output.mjs'

const SID = '01a056eb-14ab-7b63-a3c8-ef286678ecb0'

// 0.146.0 真实 --json 事件流（节选自实测；ERROR 行在 stderr，不进 stdout）
const REAL_JSONL = '{"type":"thread.started","thread_id":"' + SID + '"}\n'
  + '{"type":"turn.started"}\n'
  + '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"skill warning..."}}\n'
  + '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}\n'
  + '{"type":"turn.completed","usage":{"input_tokens":18419,"output_tokens":5}}\n'

test('isUuid：合法/非法', () => {
  assert.equal(isUuid(SID), true)
  assert.equal(isUuid(SID.toUpperCase()), true)
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid(''), false)
  assert.equal(isUuid(undefined), false)
  // 注入防御：argv 拼接面只收 UUID 形态
  assert.equal(isUuid('x; rm -rf /'), false)
})

test('parseJsonlOutput：真实事件流提取 id + 最终回答', () => {
  const r = parseJsonlOutput(REAL_JSONL)
  assert.equal(r.sessionId, SID)
  assert.equal(r.answer, 'OK') // error item 与非最终 item 不污染
})

test('parseJsonlOutput：逐行抗损——尾行截断只丢回答，id 仍在', () => {
  const truncated = REAL_JSONL + '{"type":"turn.completed","usage":{"inpu' // 半行
  const r = parseJsonlOutput(truncated)
  assert.equal(r.sessionId, SID)
  assert.equal(r.answer, 'OK')
})

test('parseJsonlOutput：thread.started 缺失/坏 id 时不产出 id', () => {
  assert.equal(parseJsonlOutput('{"type":"turn.started"}').sessionId, undefined)
  assert.equal(parseJsonlOutput('{"type":"thread.started","thread_id":"garbage"}').sessionId, undefined)
})

test('parseJsonlOutput：非 JSON 混流整段跳过（回退原文场景的安全网）', () => {
  const mixed = 'OpenAI Codex v0.146.0\n--------\n' + REAL_JSONL
  const r = parseJsonlOutput(mixed)
  assert.equal(r.sessionId, SID)
  assert.equal(r.answer, 'OK')
})

test('parseJsonlOutput：多条 agent_message 取最后一条', () => {
  const two = '{"type":"thread.started","thread_id":"' + SID + '"}\n'
    + '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n'
    + '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}'
  assert.equal(parseJsonlOutput(two).answer, 'second')
})

test('parseBannerSessionId：banner 行（大小写/首尾空白鲁棒）', () => {
  assert.equal(parseBannerSessionId('session id: ' + SID), SID)
  assert.equal(parseBannerSessionId('  session id:  ' + SID.toUpperCase() + '  '), SID.toUpperCase())
  assert.equal(parseBannerSessionId('no banner here'), undefined)
})

test('extractCodexOutput：JSONL 主源 + banner 副源双保险', () => {
  // 主源在
  const a = extractCodexOutput({ stdout: REAL_JSONL, stderr: '' })
  assert.equal(a.sessionId, SID)
  assert.equal(a.answer, 'OK')
  assert.equal(a.jsonlParsed, true)
  // JSONL 缺失时 stderr banner 兜底（codex 把 banner 也打 stderr，实测）
  const b = extractCodexOutput({ stdout: 'plain text', stderr: 'session id: ' + SID })
  assert.equal(b.sessionId, SID)
  assert.equal(b.jsonlParsed, false)
  // 双源全无
  const c = extractCodexOutput({ stdout: 'plain', stderr: 'err' })
  assert.equal(c.sessionId, undefined)
})

test('missingSessionIdReason：有 id 则 undefined，无 id 给出可行动失败原因', () => {
  assert.equal(missingSessionIdReason({ sessionId: SID }), undefined)
  const reason = missingSessionIdReason({})
  assert.match(reason, /session id was not captured/)
  assert.match(reason, /re-verify/) // 指向复核动作
})

test('sessionFooter：合法 id 输出可回传的尾行', () => {
  assert.equal(sessionFooter(SID), '\n\nsession id: ' + SID)
  assert.equal(sessionFooter(undefined), '')
})
