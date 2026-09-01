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

test('renderSnapshotLines: header + nodes + truncation marker（v0.2.0：windowId 头）', () => {
  const lines = renderSnapshotLines({
    pid: 42, windowId: 'win_abc123_7', title: 'Main',
    frame: { x: 10.2, y: 20.7, width: 800, height: 600 },
    nodes: [{ ref: '@0', depth: 0, role: 'AXWindow', title: 'Main' }],
    truncatedNodes: 5,
  })
  assert.equal(lines.length, 3)
  assert.match(lines[0], /window win_abc123_7 of pid=42 .*"Main"/)
  assert.match(lines[0], /\(10,21\) 800x600/)
  assert.match(lines[2], /5 nodes truncated/)
})

test('renderSnapshotLines: empty tree → hint not error', () => {
  const lines = renderSnapshotLines({ pid: 1, windowId: 'win_abc123_1', nodes: [] })
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

test('renderWindowsLines: 按 app 分组 + windowId 句柄 + capture/minimized 标记（v0.2.0）', () => {
  const empty = renderWindowsLines({ windows: [], hint: 'app 暂未响应 AX 请求' })
  assert.match(empty[0], /no windows/)
  assert.match(empty[0], /app 暂未响应 AX 请求/)
  const wins = renderWindowsLines({
    windows: [
      { windowId: 'win_n_1', pid: 8, appName: 'Edit', title: 'Doc', frame: { x: 0, y: 0, width: 100, height: 50 }, minimized: false, main: true, captureAvailable: true },
      { windowId: 'win_n_2', pid: 8, appName: 'Edit', title: 'Zed', minimized: true, captureAvailable: false },
      { windowId: 'win_n_3', pid: 9, appName: 'Web', title: 'Home', frame: { x: 1, y: 2, width: 30, height: 40 }, minimized: false, main: false, focused: true, captureAvailable: true },
    ],
  })
  // 分组头（同 app 一次）+ 每窗一行
  assert.match(wins[0], /pid=8 Edit/)
  assert.match(wins[1], /win_n_1 "Doc".*\(0,0\) 100x50.*\[main\].*\[capture ✓\]/)
  assert.match(wins[2], /win_n_2 "Zed".*\[minimized\]/)
  assert.doesNotMatch(wins[2], /\[capture ✓\]/)
  assert.match(wins[3], /pid=9 Web/)
  assert.match(wins[4], /win_n_3 "Home".*\[focused\]/)
})
