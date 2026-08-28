// approve.mjs 单测：mock userQuestions 服务，验证各分支的 fail-closed 语义。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestActionApproval } from '../src/approve.mjs'

function makeCtx(askImpl) {
  return {
    get(name) {
      if (name === 'userQuestions') return { ask: askImpl }
      return undefined
    },
  }
}

test('approve: 允许一次 → once', async () => {
  let captured
  const ctx = makeCtx(async (req) => {
    captured = req
    return { answers: [{ selected: ['允许一次'], custom: '' }] }
  })
  const r = await requestActionApproval(ctx, { agent: {}, tool: 'computer_click', detail: 'x' })
  assert.equal(r.verdict, 'once')
  // 校验问题结构：标题含工具名、有允许/拒绝两个选项。
  const q = captured.questions[0]
  assert.match(q.question, /computer_click/)
  assert.deepEqual(q.options.map((o) => o.label), ['允许一次', '拒绝'])
})

test('approve: 自定义备注随 once 返回', async () => {
  const ctx = makeCtx(async () => ({ answers: [{ selected: ['允许一次'], custom: '只许点这个' }] }))
  const r = await requestActionApproval(ctx, { agent: {}, tool: 'computer_type', detail: 'x' })
  assert.equal(r.verdict, 'once')
  assert.equal(r.note, '只许点这个')
})

test('approve: 拒绝 → denied', async () => {
  const ctx = makeCtx(async () => ({ answers: [{ selected: ['拒绝'], custom: '' }] }))
  const r = await requestActionApproval(ctx, { agent: {}, tool: 'computer_key', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.match(r.reason, /拒绝/)
})

test('approve: 未选任何项 → denied（fail-closed）', async () => {
  const ctx = makeCtx(async () => ({ answers: [{ selected: [], custom: '' }] }))
  const r = await requestActionApproval(ctx, { agent: {}, tool: 'computer_menu', detail: 'x' })
  assert.equal(r.verdict, 'denied')
})

test('approve: ask 抛错（DELEGATED_CALLER 等）→ denied', async () => {
  const ctx = makeCtx(async () => { throw new Error('DELEGATED_CALLER') })
  const r = await requestActionApproval(ctx, { agent: {}, tool: 'computer_app', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.match(r.reason, /DELEGATED_CALLER/)
})

test('approve: 无 userQuestions 服务 → denied', async () => {
  const r = await requestActionApproval({ get: () => undefined }, { agent: {}, tool: 'computer_click', detail: 'x' })
  assert.equal(r.verdict, 'denied')
  assert.match(r.reason, /无 userQuestions/)
})
