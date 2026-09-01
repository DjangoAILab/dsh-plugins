import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAccessibilityTree } from '../src/snapshot.mjs'

function ax(partial) {
  return { ignored: false, childIds: [], ...partial }
}

test('renderAccessibilityTree: empty → placeholder + empty refs', () => {
  assert.deepEqual(renderAccessibilityTree([]), { text: '(empty accessibility tree)', refs: new Map(), refsMeta: new Map() })
})

test('renderAccessibilityTree: interactive roles get refs', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['b', 't'] }),
    ax({ nodeId: 'b', parentId: 'root', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 11 }),
    ax({ nodeId: 't', parentId: 'root', role: { value: 'textbox' }, name: { value: 'Search' }, backendDOMNodeId: 22 }),
  ]
  const { text, refs, refsMeta } = renderAccessibilityTree(nodes)
  assert.match(text, /RootWebArea "Page"/)
  assert.match(text, /button "Submit" \[ref=@1\]/)
  assert.match(text, /textbox "Search" \[ref=@2\]/)
  assert.equal(refs.get('1'), 11)
  assert.equal(refs.get('2'), 22)
  assert.deepEqual(refsMeta.get('1'), { role: 'button', name: 'Submit' })
  assert.deepEqual(refsMeta.get('2'), { role: 'textbox', name: 'Search' })
})

test('renderAccessibilityTree: static roles render but get no ref', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['h', 'p', 'img', 'btn'] }),
    ax({ nodeId: 'h', parentId: 'root', role: { value: 'heading' }, name: { value: 'Title' }, backendDOMNodeId: 1, childIds: ['st'] }),
    ax({ nodeId: 'st', parentId: 'h', role: { value: 'StaticText' }, name: { value: 'Title' }, backendDOMNodeId: 2 }),
    ax({ nodeId: 'p', parentId: 'root', role: { value: 'paragraph' }, backendDOMNodeId: 3 }),
    ax({ nodeId: 'img', parentId: 'root', role: { value: 'image' }, name: { value: 'logo' }, backendDOMNodeId: 4 }),
    ax({ nodeId: 'btn', parentId: 'root', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }),
  ]
  const { text, refs } = renderAccessibilityTree(nodes)
  // 静态角色正常渲染行但不带 ref；StaticText 直接并入该行文本（保持子层缩进）。
  assert.match(text, /- heading "Title"\n    - Title/)
  assert.match(text, /- paragraph/)
  assert.match(text, /- image "logo"/)
  // 唯一的 ref 给了 button。
  assert.match(text, /button "Go" \[ref=@1\]/)
  assert.equal(refs.size, 1)
  assert.equal(refs.get('1'), 5)
  assert.equal((text.match(/ref=@/g) || []).length, 1)
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

test('renderAccessibilityTree: generic container renders without ref', () => {
  const nodes = [
    ax({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['g'] }),
    ax({ nodeId: 'g', parentId: 'root', role: { value: 'generic' }, backendDOMNodeId: 9, childIds: ['c'] }),
    ax({ nodeId: 'c', parentId: 'g', role: { value: 'checkbox' }, name: { value: 'opt' }, backendDOMNodeId: 10 }),
  ]
  const { text, refs } = renderAccessibilityTree(nodes)
  assert.match(text, /- generic/)
  assert.doesNotMatch(text, /generic \[ref=/)
  assert.match(text, /checkbox "opt" \[ref=@1\]/)
  assert.equal(refs.get('1'), 10)
})
