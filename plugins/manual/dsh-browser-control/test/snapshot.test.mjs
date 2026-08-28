import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAccessibilityTree } from '../src/snapshot.mjs'

function ax(partial) {
  return { ignored: false, childIds: [], ...partial }
}

test('renderAccessibilityTree: empty → placeholder + empty refs', () => {
  assert.deepEqual(renderAccessibilityTree([]), { text: '(empty accessibility tree)', refs: new Map() })
})

test('renderAccessibilityTree: flat tree with stable refs', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['b', 't'] }),
    ax({ nodeId: 'b', parentId: 'root', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 11 }),
    ax({ nodeId: 't', parentId: 'root', role: { value: 'textbox' }, name: { value: 'Search' }, backendDOMNodeId: 22 }),
  ]
  const { text, refs } = renderAccessibilityTree(nodes)
  assert.match(text, /RootWebArea "Page"/)
  assert.match(text, /button "Submit" \[ref=@1\]/)
  assert.match(text, /textbox "Search" \[ref=@2\]/)
  assert.equal(refs.get('1'), 11)
  assert.equal(refs.get('2'), 22)
})

test('renderAccessibilityTree: ignored node skipped, children keep depth', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['ig'] }),
    ax({ nodeId: 'ig', parentId: 'root', ignored: true, role: { value: 'generic' }, childIds: ['b'] }),
    ax({ nodeId: 'b', parentId: 'ig', role: { value: 'link' }, name: { value: 'x' }, backendDOMNodeId: 5 }),
  ]
  const { text, refs } = renderAccessibilityTree(nodes)
  // ignored 节点被折叠：其子节点停在 ignored 节点所处的深度（root 的直接子层 = 1 层缩进）。
  assert.match(text, /- RootWebArea\n  - link "x" \[ref=@1\]/)
  assert.equal(refs.get('1'), 5)
})

test('renderAccessibilityTree: nodes without backendDOMNodeId get no ref', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['h'] }),
    ax({ nodeId: 'h', parentId: 'root', role: { value: 'heading' }, name: { value: 'Title' } }),
  ]
  const { text, refs } = renderAccessibilityTree(nodes)
  assert.equal(refs.size, 0)
  assert.doesNotMatch(text, /ref=/)
})