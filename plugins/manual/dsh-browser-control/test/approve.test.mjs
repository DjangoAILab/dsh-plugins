import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestActionApproval } from '../src/approve.mjs'

function fakeCtx(questions) {
  return { get: (name) => (name === 'userQuestions' ? questions : undefined) }
}

test('requestActionApproval: no userQuestions service → denied', async () => {
  const r = await requestActionApproval(fakeCtx(undefined), { agent: {}, tool: 'browser_click', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.match(r.reason, /无 userQuestions/)
})

test('requestActionApproval: 允许一次 → once', async () => {
  const questions = { ask: async () => ({ answers: [{ selected: ['允许一次'] }] }) }
  const r = await requestActionApproval(fakeCtx(questions), { agent: {}, tool: 'browser_click', detail: 'x' })
  assert.equal(r.verdict, 'once')
})

test('requestActionApproval: no allow selected → denied with custom reason', async () => {
  const questions = { ask: async () => ({ answers: [{ selected: [], custom: 'no thanks' }] }) }
  const r = await requestActionApproval(fakeCtx(questions), { agent: {}, tool: 'browser_click', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.equal(r.reason, 'no thanks')
})

test('requestActionApproval: ask throws (DELEGATED_CALLER) → denied fail-closed', async () => {
  const err = Object.assign(
    new Error('human interaction is unavailable while the calling agent is owned by another live agent'),
    { code: 'DELEGATED_CALLER' },
  )
  const questions = { ask: async () => { throw err } }
  const r = await requestActionApproval(fakeCtx(questions), { agent: {}, tool: 'browser_type', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.match(r.reason, /审批失败/)
})

test('requestActionApproval: passes agent and question shape through', async () => {
  let captured
  const questions = { ask: async (req) => { captured = req; return { answers: [{ selected: ['允许一次'] }] } } }
  const agent = { id: 's1' }
  await requestActionApproval(fakeCtx(questions), { agent, tool: 'browser_click', detail: 'detail here' })
  assert.equal(captured.agent, agent)
  assert.equal(captured.questions[0].id, 'browser-action-approve')
  assert.match(captured.questions[0].detail, /detail here/)
})