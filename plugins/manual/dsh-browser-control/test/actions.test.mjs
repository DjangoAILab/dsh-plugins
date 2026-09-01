import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForAccessibility, buildKeyEvent, waitFor, deleteCookies } from '../src/actions.mjs'

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

// 记录 CDP 命令的伪 client（deleteCookies 分派断言用）。
function recordingClient() {
  const calls = []
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'Network.getCookies') return { cookies: [] }
      return {}
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

// ===== buildKeyEvent（pressKey 的参数构造，纯函数）=====

test('buildKeyEvent: single letter produces code/text/unmodifiedText/vkc', () => {
  const events = buildKeyEvent('a', {})
  assert.equal(events.length, 2)
  const [down, up] = events
  assert.equal(down.type, 'keyDown')
  assert.equal(down.code, 'KeyA')
  assert.equal(down.key, 'a')
  assert.equal(down.text, 'a')
  assert.equal(down.unmodifiedText, 'a')
  assert.equal(down.windowsVirtualKeyCode, 65)
  assert.equal(down.modifiers, 0)
  assert.equal(up.type, 'keyUp')
  assert.equal(up.code, 'KeyA')
  assert.equal(up.text, undefined) // keyUp 一律不带 text（对照 puppeteer Input.up）
  assert.equal(up.unmodifiedText, undefined)
})

test('buildKeyEvent: shift+letter → uppercase text/key', () => {
  const [down] = buildKeyEvent('a', { shift: true })
  assert.equal(down.modifiers, 8)
  assert.equal(down.key, 'A')
  assert.equal(down.text, 'A')
  assert.equal(down.unmodifiedText, 'a')
  assert.equal(down.windowsVirtualKeyCode, 65)
})

test('buildKeyEvent: digit → Digit code + vkc of the digit', () => {
  const [down] = buildKeyEvent('5', {})
  assert.equal(down.code, 'Digit5')
  assert.equal(down.text, '5')
  assert.equal(down.windowsVirtualKeyCode, 53) // '5'.charCodeAt(0)
})

test('buildKeyEvent: shift + base digit produces shifted-symbol text with base key identity', () => {
  // 底位数字 + shift：key/code/vkc 用底位（'1'/Digit1/49），text 为 shift 后符号 '!'；
  // unmodifiedText 为不按 shift 时的字符（CDP「without modifiers」定义），即底位 '1'。
  const [down, up] = buildKeyEvent('1', { shift: true })
  assert.equal(down.key, '1')
  assert.equal(down.code, 'Digit1')
  assert.equal(down.text, '!')
  assert.equal(down.unmodifiedText, '1')
  assert.equal(down.windowsVirtualKeyCode, 49)
  assert.equal(down.modifiers, 8)
  assert.equal(up.text, undefined)
})

test('buildKeyEvent: shifted symbol without shift maps back to its base key', () => {
  // 输入本身是 shift 后符号（'!'）：对齐 puppeteer '!' 定义 → code Digit1、vkc 49；
  // text 为符号本身，unmodifiedText 反查底位字符 '1'。
  const [down, up] = buildKeyEvent('!', {})
  assert.equal(down.key, '!')
  assert.equal(down.text, '!')
  assert.equal(down.unmodifiedText, '1')
  assert.equal(down.code, 'Digit1')
  assert.equal(down.windowsVirtualKeyCode, 49)
  assert.equal(down.modifiers, 0)
  assert.equal(up.text, undefined)
})

test('buildKeyEvent: shifted symbol explicitly with shift keeps symbol text and base identity', () => {
  // '!' + shift（模型显式带上 shift 修饰）：语义同无 shift 的 '!'。
  const [down] = buildKeyEvent('!', { shift: true })
  assert.equal(down.key, '!')
  assert.equal(down.text, '!')
  assert.equal(down.unmodifiedText, '1')
  assert.equal(down.code, 'Digit1')
  assert.equal(down.windowsVirtualKeyCode, 49)
  assert.equal(down.modifiers, 8)
})

test('buildKeyEvent: base symbol + shift produces shifted symbol', () => {
  // 底位符号 + shift：'-' → '_'，code/vkc 用底位键 Minus/189；unmodifiedText 为底位 '-'。
  const [down] = buildKeyEvent('-', { shift: true })
  assert.equal(down.key, '-')
  assert.equal(down.text, '_')
  assert.equal(down.unmodifiedText, '-')
  assert.equal(down.code, 'Minus')
  assert.equal(down.windowsVirtualKeyCode, 189)
  assert.equal(down.modifiers, 8)
})

test('buildKeyEvent: symbol without shift keeps own code and OEM vkc', () => {
  const [down] = buildKeyEvent(';', {})
  assert.equal(down.code, 'Semicolon')
  assert.equal(down.text, ';')
  assert.equal(down.unmodifiedText, ';')
  assert.equal(down.windowsVirtualKeyCode, 186) // OEM VKC（非 ASCII），对齐 puppeteer
})

test('buildKeyEvent: known key (Enter) keeps table code, no text', () => {
  const [down, up] = buildKeyEvent('Enter', {})
  assert.equal(down.code, 'Enter')
  assert.equal(down.windowsVirtualKeyCode, 13)
  assert.equal(down.text, undefined)
  assert.equal(up.text, undefined)
})

test('buildKeyEvent: Backspace keyDown/keyUp carry no text', () => {
  // 修复回归锚点：旧实现 keyUp 带 text 会再插入一次字符（value="ab" → 按一次 Backspace 剩 "a"）。
  const [down, up] = buildKeyEvent('Backspace', {})
  assert.equal(down.windowsVirtualKeyCode, 8)
  assert.equal(down.text, undefined)
  assert.equal(down.unmodifiedText, undefined)
  assert.equal(up.text, undefined)
  assert.equal(up.unmodifiedText, undefined)
})

test('buildKeyEvent: Space emits text=" " on keyDown only', () => {
  const [down, up] = buildKeyEvent('Space', {})
  assert.equal(down.code, 'Space')
  assert.equal(down.text, ' ')
  assert.equal(down.windowsVirtualKeyCode, 32)
  assert.equal(up.text, undefined) // 旧实现 keyUp 带 text 会多插一个空格
})

test('buildKeyEvent: ctrl/meta/alt + Space carry no text (shortcut, not input)', () => {
  // ctrl+Space 是 IME 切换类快捷键，keyDown 不得带 text（与 ctrl+字母 同规则）。
  for (const modifiers of [{ ctrl: true }, { meta: true }, { alt: true }]) {
    const [down, up] = buildKeyEvent('Space', modifiers)
    assert.equal(down.text, undefined, JSON.stringify(modifiers))
    assert.equal(down.unmodifiedText, undefined, JSON.stringify(modifiers))
    assert.equal(down.code, 'Space')
    assert.equal(down.windowsVirtualKeyCode, 32)
    assert.equal(up.text, undefined)
  }
})

test('buildKeyEvent: function keys map to F-table without text', () => {
  const [f1down, f1up] = buildKeyEvent('F1', {})
  assert.equal(f1down.code, 'F1')
  assert.equal(f1down.windowsVirtualKeyCode, 112)
  assert.equal(f1down.text, undefined) // 功能键无文本
  assert.equal(f1up.code, 'F1')
  assert.equal(f1up.text, undefined)
  const [f12down] = buildKeyEvent('F12', {})
  assert.equal(f12down.code, 'F12')
  assert.equal(f12down.windowsVirtualKeyCode, 123)
  const [insDown] = buildKeyEvent('Insert', {})
  assert.equal(insDown.code, 'Insert')
  assert.equal(insDown.windowsVirtualKeyCode, 45)
  assert.equal(insDown.text, undefined)
  const [capsDown] = buildKeyEvent('CapsLock', {})
  assert.equal(capsDown.code, 'CapsLock')
  assert.equal(capsDown.windowsVirtualKeyCode, 20)
})

test('buildKeyEvent: ctrl/meta/alt + printable char produce no text (shortcut, not input)', () => {
  // 修复回归锚点：旧实现 ctrl+'a' 带 text，被 Chrome 当成文本输入 'a' 而非全选快捷键。
  for (const modifiers of [{ ctrl: true }, { meta: true }, { alt: true }, { ctrl: true, shift: true }]) {
    const [down, up] = buildKeyEvent('a', modifiers)
    assert.equal(down.text, undefined, JSON.stringify(modifiers))
    assert.equal(down.unmodifiedText, undefined, JSON.stringify(modifiers))
    assert.equal(down.code, 'KeyA')
    assert.equal(up.text, undefined)
  }
})

test('buildKeyEvent: ctrl modifier sets bit 2, shift-only keeps text', () => {
  const [ctrlDown] = buildKeyEvent('c', { ctrl: true })
  assert.equal(ctrlDown.modifiers, 2)
  assert.equal(ctrlDown.code, 'KeyC')
  assert.equal(ctrlDown.text, undefined) // ctrl 组合是快捷键，不带 text
  const [shiftDown] = buildKeyEvent('c', { shift: true })
  assert.equal(shiftDown.modifiers, 8)
  assert.equal(shiftDown.text, 'C') // shift 单独存在时正常带 text
})

test('buildKeyEvent: unknown multi-char key degrades with no text, vkc 0', () => {
  const [down, up] = buildKeyEvent('MediaPlay', {})
  assert.equal(down.key, 'MediaPlay')
  assert.equal(down.code, 'MediaPlay')
  assert.equal(down.windowsVirtualKeyCode, 0)
  assert.equal(down.text, undefined)
  assert.equal(up.text, undefined)
})

// ===== waitFor 空参 =====

test('waitFor: throws when neither selector nor text given', async () => {
  const client = recordingClient()
  await assert.rejects(
    () => waitFor(client, {}),
    /wait_for 需要 selector 或 text 至少一个/,
  )
  // 未发任何 CDP 命令（进入循环前就拒绝）。
  assert.equal(client.calls.length, 0)
})

// ===== deleteCookies 分派 =====

test('deleteCookies: no name → clearBrowserCookies', async () => {
  const client = recordingClient()
  await deleteCookies(client)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].method, 'Network.clearBrowserCookies')
})

test('deleteCookies: with name → deleteCookies with name', async () => {
  const client = recordingClient()
  await deleteCookies(client, 'sid')
  assert.equal(client.calls[0].method, 'Network.deleteCookies')
  assert.deepEqual(client.calls[0].params, { name: 'sid' })
})

test('deleteCookies: name + url → deleteCookies with both', async () => {
  const client = recordingClient()
  await deleteCookies(client, 'sid', 'https://example.com')
  assert.deepEqual(client.calls[0].params, { name: 'sid', url: 'https://example.com' })
})
