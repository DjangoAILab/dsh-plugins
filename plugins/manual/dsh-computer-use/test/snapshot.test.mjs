import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNodeLine, renderSnapshotLines, renderAppsLines, renderWindowsLines } from '../src/snapshot.mjs'

test('renderNodeLine: depth indent + ref + role + title', () => {
  const line = renderNodeLine({ ref: '@0/1', depth: 2, role: 'AXButton', title: '确定' })
  assert.match(line, /^ {4}- @0\/1 AXButton/)
  assert.ok(line.includes(JSON.stringify('确定')))
})

test('renderNodeLine: value/description/actions/focused', () => {
  const line = renderNodeLine({
    ref: '@0', depth: 0, role: 'AXTextField', value: 'hello', description: '搜索',
    actions: ['AXConfirm'], focused: true,
  })
  assert.match(line, /value="hello"/)
  assert.match(line, /"搜索"/)
  assert.match(line, /\[AXConfirm\]/)
  assert.match(line, /\*FOCUSED\*/)
})

test('renderNodeLine: long value strings truncated at 80', () => {
  const line = renderNodeLine({ ref: '@1', depth: 0, role: 'AXStaticText', value: 'x'.repeat(200) })
  assert.ok(line.length < 200)
})

test('renderSnapshotLines: header + nodes + truncation marker', () => {
  const lines = renderSnapshotLines({
    pid: 42, windowIndex: 1, windowCount: 3, title: 'Main',
    frame: { x: 10.2, y: 20.7, width: 800, height: 600 },
    nodes: [{ ref: '@0', depth: 0, role: 'AXWindow', title: 'Main' }],
    truncatedNodes: 5,
  })
  assert.equal(lines.length, 3)
  assert.match(lines[0], /window 1\/3 of pid=42 .*"Main"/)
  assert.match(lines[0], /\(10,21\) 800x600/)
  assert.match(lines[2], /5 nodes truncated/)
})

test('renderSnapshotLines: empty tree → hint not error', () => {
  const lines = renderSnapshotLines({ pid: 1, windowIndex: 0, windowCount: 1, nodes: [] })
  assert.equal(lines.length, 2)
  assert.match(lines[1], /empty AX tree/)
})

test('renderAppsLines: ax=null vs count, frontmost/hidden flags', () => {
  const lines = renderAppsLines([
    { pid: 1, name: 'Finder', bundleId: 'com.apple.finder', frontmost: true, hidden: false, axWindows: 2 },
    { pid: 2, name: 'Code', bundleId: null, frontmost: false, hidden: false, axWindows: null },
  ])
  assert.match(lines[0], /pid=1 Finder.*axWin=2.*\[frontmost\]/)
  assert.match(lines[1], /pid=2 Code.*ax=\?/)
})

test('renderAppsLines: empty', () => {
  assert.deepEqual(renderAppsLines([]), ['(no regular GUI apps running)'])
})

test('renderWindowsLines: hint path + window path', () => {
  const hint = renderWindowsLines({ windows: [], hint: 'app 未暴露 AX 树' })
  assert.match(hint[0], /app 未暴露 AX 树/)
  const wins = renderWindowsLines({
    windows: [
      { ref: 'w0', title: 'Doc', frame: { x: 0, y: 0, width: 100, height: 50 }, minimized: false, main: true },
      { ref: 'w1', title: 'Zed', minimized: true },
    ],
  })
  assert.match(wins[0], /w0 "Doc"  \(0,0\) 100x50 \[main\]/)
  assert.match(wins[1], /w1 "Zed"\s+\[minimized\]/)
})
