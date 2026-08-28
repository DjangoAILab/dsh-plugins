import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForAccessibility } from '../src/actions.mjs'

// 伪 CDP client：Accessibility.enable 空返回，getFullAXTree 按序吐树。
function fakeClient(treeSequence) {
  let i = 0
  return {
    async send(method) {
      if (method === 'Accessibility.enable') return {}
      if (method === 'Accessibility.getFullAXTree') {
        const nodes = treeSequence[Math.min(i, treeSequence.length - 1)]
        i += 1
        return { nodes }
      }
      throw new Error('unexpected method: ' + method)
    },
  }
}

const EMPTY = [{ nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, childIds: [] }]
const POPULATED = [
  { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, childIds: ['h'] },
  { nodeId: 'h', parentId: 'root', ignored: false, role: { value: 'heading' }, name: { value: 'X' }, backendDOMNodeId: 1 },
]

test('waitForAccessibility: polls until tree is populated', async () => {
  // 前两次空树，第三次才有内容 → 应轮询到第三次并返回 POPULATED。
  const nodes = await waitForAccessibility(fakeClient([EMPTY, EMPTY, POPULATED]), { timeoutMs: 5000 })
  assert.ok(nodes.some((n) => n.role && n.role.value === 'heading'))
})

test('waitForAccessibility: immediately ready when first tree is populated', async () => {
  const nodes = await waitForAccessibility(fakeClient([POPULATED]), { timeoutMs: 5000 })
  assert.ok(nodes.some((n) => n.role && n.role.value === 'heading'))
})

test('waitForAccessibility: returns current tree on timeout (never stops empty)', async () => {
  const nodes = await waitForAccessibility(fakeClient([EMPTY]), { timeoutMs: 10 })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].role.value, 'RootWebArea')
})