// CDP 动作原语：观察（a11y 树快照）、定位（ref/selector → 视口中心点）、动作（点击/输入）。
// 刻意不 import @deepseek-ai/dsh-tools，因此既被 tools.mjs 复用，也能被 scripts/cdp-smoke.mjs
// 在真实 Chrome 上单测（验证 a11y / scrollIntoView / getBoundingClientRect / 鼠标事件 / insertText 协议假设）。

import { evaluate, waitForLoad } from './cdp.mjs'
import { renderAccessibilityTree } from './snapshot.mjs'

export async function getNodes(client) {
  await client.send('Accessibility.enable')
  const res = await client.send('Accessibility.getFullAXTree')
  return Array.isArray(res.nodes) ? res.nodes : []
}

/** 等待 a11y 树就绪：真实站点在 readyState=complete 后，getFullAXTree 可能短暂只返回
 * 一个空根节点（无 childIds）。轮询直到根有子树或出现非根节点；有界超时（默认 3000ms，
 * 每 100ms 一次）后返回当前树——宁可慢，不让 navigate 后紧接着的 snapshot 拿到空树。 */
export async function waitForAccessibility(client, options = {}) {
  const timeout = options.timeoutMs ?? 3000
  const deadline = Date.now() + timeout
  let nodes = []
  for (;;) {
    nodes = await getNodes(client)
    const ready = nodes.some(
      (n) => n && n.ignored !== true && n.role &&
        (n.role.value !== 'RootWebArea' || (n.childIds || []).length > 0),
    )
    if (ready || Date.now() > deadline) return nodes
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function snapshot(client) {
  return renderAccessibilityTree(await getNodes(client))
}

/** ref（"@5"）→ 非 ignored 节点的 backendDOMNodeId；重新抓树保证与快照一致。 */
export async function refToBackendNodeId(client, ref) {
  const index = String(ref).replace(/^@/, '')
  const { refs } = renderAccessibilityTree(await getNodes(client))
  const backendNodeId = refs.get(index)
  if (backendNodeId === undefined) {
    throw new Error('browser: 无效 ref @' + index + '，请先跑 browser_snapshot 拿最新 ref；' +
      'ref 来自最近一次 browser_snapshot，页面可能已变化，若点击效果与预期不符请重新 snapshot')
  }
  return backendNodeId
}

// ===== 视口坐标系定位 =====
// Input.dispatchMouseEvent 用**视口坐标**；DOM.getBoxModel 给的是**文档坐标**——页面一滚动
// 两者就差一个 scrollY，点击就静默落空。因此这里统一：先 scrollIntoView 确保元素在视口内，
// 再用 getBoundingClientRect（视口系）取中心点，并校验点落在 [0, innerWidth/Height] 内。

/** 确保目标元素滚动进视口中央；返回是否命中元素（供调用方报错）。ref → backendNodeId，
 * selector → querySelector，两条路都在页面里走 getBoundingClientRect（视口坐标系）。 */
async function ensureInViewport(client, target) {
  if (target.ref) {
    const backendNodeId = await refToBackendNodeId(client, target.ref)
    const node = await client.send('DOM.resolveNode', { backendNodeId })
    const objectId = node.object && node.object.objectId
    if (!objectId) throw new Error('browser: 无法解析该 ref 的 DOM 对象')
    const res = await client.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function() { this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); ' +
        'const r = this.getBoundingClientRect(); ' +
        'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ' +
        'w: window.innerWidth, h: window.innerHeight, visible: r.width > 0 && r.height > 0 }; }',
      arguments: [],
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error('browser: 元素定位抛错: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'))
    }
    const p = res.result && res.result.value
    if (!p) throw new Error('browser: 该 ref 节点不是 DOM 元素（不可点击）')
    return p
  }
  if (target.selector) {
    const expr =
      '(() => { const el = document.querySelector(' + JSON.stringify(target.selector) + '); ' +
      'if (!el) return null; ' +
      'el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); ' +
      'const r = el.getBoundingClientRect(); ' +
      'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ' +
      'w: window.innerWidth, h: window.innerHeight, visible: r.width > 0 && r.height > 0 }; })()'
    const p = await evaluate(client, expr)
    if (!p) throw new Error('browser: selector 未命中元素：' + target.selector)
    return p
  }
  throw new Error('browser: 需要 ref（来自 browser_snapshot）或 selector（CSS）')
}

/** 解析点击/输入目标为**视口坐标系**中心点：确保滚动 → getBoundingClientRect 取点 → 边界校验。 */
export async function resolvePoint(client, target) {
  const p = await ensureInViewport(client, target)
  if (p.visible === false) {
    throw new Error('browser: 目标元素不可见（零尺寸，可能 display:none 或已分离）')
  }
  if (p.x < 0 || p.y < 0 || p.x > p.w || p.y > p.h) {
    throw new Error('browser: 目标元素中心点 (' + p.x + ',' + p.y + ') 在视口 (' + p.w + 'x' + p.h + ') 之外，' +
      '请先 browser_scroll 或调整窗口后再试')
  }
  return { x: p.x, y: p.y }
}

export async function mouseClick(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 在已聚焦元素插入纯文本（调用方先聚焦目标元素）。 */
export async function typeText(client, text) {
  await client.send('Input.insertText', { text: String(text) })
}

/** 显式聚焦目标元素（点完鼠标后兜底；focus 失败（不可聚焦）不报错，继续 insertText）。 */
export async function focusElement(client, target) {
  await withElement(client, target, 'function() { try { this.focus(); } catch { /* 不可聚焦 */ } return true; }')
}

// ===== 导航历史 =====
// 用 CDP 历史导航（history.back() 是异步无名火：waitForLoad 可能在导航真正开始前就轮询）。
export async function goBack(client) {
  const hist = await client.send('Page.getNavigationHistory')
  const prev = hist.entries && hist.entries[hist.currentIndex - 1]
  if (!prev) throw new Error('browser: 没有更早的历史可导航')
  await client.send('Page.navigateToHistoryEntry', { entryId: prev.id })
  await waitForLoad(client)
  await waitForAccessibility(client)
  const url = await evaluate(client, 'location.href')
  return typeof url === 'string' ? url : ''
}

export async function goForward(client) {
  const hist = await client.send('Page.getNavigationHistory')
  const next = hist.entries && hist.entries[hist.currentIndex + 1]
  if (!next) throw new Error('browser: 没有更晚的历史可导航')
  await client.send('Page.navigateToHistoryEntry', { entryId: next.id })
  await waitForLoad(client)
  await waitForAccessibility(client)
  const url = await evaluate(client, 'location.href')
  return typeof url === 'string' ? url : ''
}

export async function reload(client) {
  await client.send('Page.reload')
  await waitForLoad(client)
  await waitForAccessibility(client)
  const url = await evaluate(client, 'location.href')
  return typeof url === 'string' ? url : ''
}

// ===== 元素 JS 操作通用器：ref → DOM.resolveNode → objectId；selector → querySelector =====
export async function withElement(client, target, fn, ...args) {
  if (target.selector) {
    const expr =
      '(function() { const el = document.querySelector(' + JSON.stringify(target.selector) + '); ' +
      'if (!el) return { __err: "selector 未命中" }; ' +
      'return (' + fn + ').call(el, ' + args.map((a) => JSON.stringify(a)).join(', ') + '); })()'
    const res = await evaluate(client, expr)
    if (res && res.__err) throw new Error('browser: selector 未命中元素')
    return res
  }
  if (target.ref) {
    const backendNodeId = await refToBackendNodeId(client, target.ref)
    const node = await client.send('DOM.resolveNode', { backendNodeId })
    const objectId = node.object && node.object.objectId
    if (!objectId) throw new Error('browser: 无法解析该 ref 的 DOM 对象')
    const res = await client.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error('browser: 元素操作抛错: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'))
    }
    return res.result && res.result.value
  }
  throw new Error('browser: 需要 ref（browser_snapshot）或 selector（CSS）')
}

/** 填表：清空重填 + 派发 input/change（让 React/Vue 等框架感知）。 */
export async function fillValue(client, target, text) {
  const fn =
    'function(text) { ' +
    'const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; ' +
    'Object.getOwnPropertyDescriptor(proto, "value").set.call(this, text); ' +
    'this.dispatchEvent(new Event("input", { bubbles: true })); ' +
    'this.dispatchEvent(new Event("change", { bubbles: true })); return true; }'
  if ((await withElement(client, target, fn, String(text))) !== true) {
    throw new Error('browser: fill 只对 input/textarea 有效')
  }
}

/** 下拉选择：原生 <select> 按 value 或可见文本匹配 option 并派发 change。 */
export async function selectOption(client, target, valueOrLabel) {
  const fn =
    'function(v) { if (this.tagName !== "SELECT") return false; ' +
    'const opts = [...this.options]; ' +
    'const m = opts.find((o) => o.value === v) || opts.find((o) => (o.textContent || "").trim() === v); ' +
    'if (!m) return false; this.value = m.value; ' +
    'this.dispatchEvent(new Event("input", { bubbles: true })); ' +
    'this.dispatchEvent(new Event("change", { bubbles: true })); return true; }'
  if ((await withElement(client, target, fn, String(valueOrLabel))) !== true) {
    throw new Error('browser: select_option 目标不是 <select> 或未找到匹配项')
  }
}

/** 悬停：鼠标移到元素中心，不点击。 */
export async function hover(client, target) {
  const point = await resolvePoint(client, target)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
}

/** 滚动：给 ref/selector 则 scrollIntoView；否则按 deltaY/deltaX 滚轮滚动页面。 */
export async function scroll(client, target, deltaY = 0, deltaX = 0) {
  if (target && (target.ref || target.selector)) {
    await withElement(client, target, 'function() { this.scrollIntoView({ block: "center" }); return true; }')
    return
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0 })
}

// ===== 键盘事件 =====
// 事件参数构造对齐 puppeteer _keyDefinitions / Input.up 语义（US 键盘）：
// - keyUp 一律不带 text/unmodifiedText（Chrome 只在 keyDown 消费 text；带 text 的 keyUp 会
//   再插入一次字符——实测 Backspace/Space 因此多删/多打一次）。
// - keyDown 的 text 只在无 ctrl/meta/alt 时产生：这类组合键是快捷键（ctrl+a=全选），
//   带 text 会被 Chrome 当成文本输入；shift 单独存在（或无修饰）才正常带 text。
// - shift 映射（US 主区）：输入「底位字符 + shift」→ key/code/vkc 用底位（'1'/Digit1/49）、
//   text 为 shift 后符号 '!'；输入直接是「shift 后符号」（'!'，无论是否带 shift 修饰）→
//   text 为符号本身、unmodifiedText 反查底位字符、key/code/vkc 用底位（'!' → Digit1/49，
//   对齐 puppeteer 对 '!' 的定义）。

// 底位字符 → shift 后符号（US 键盘主区）。
const BASE_TO_SHIFT = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
  ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
}
// 反查表：shift 后符号 → 底位字符（由 BASE_TO_SHIFT 派生，保证两表一致）。
const SHIFT_TO_BASE = Object.fromEntries(
  Object.entries(BASE_TO_SHIFT).map(([base, shifted]) => [shifted, base]),
)
// 符号底位键的 [code, Windows VKC]（VKC 取 OEM code，对齐 puppeteer _keyDefinitions 的 keyCode，非 ASCII）。
const SYMBOL_KEYS = {
  '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187],
  '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
}

/** 构造 Input.dispatchKeyEvent 的事件参数（纯函数，可单测）。
 * @returns {Array<{ type: 'keyDown'|'keyUp', key, code, text?, unmodifiedText?, windowsVirtualKeyCode, modifiers }>}
 */
export function buildKeyEvent(key, modifiers = {}) {
  const mod = (modifiers.ctrl ? 2 : 0) | (modifiers.alt ? 1 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0)
  // ctrl/meta/alt 任一存在时组合键是快捷键（如 ctrl+a 全选），keyDown 不带 text，避免被当成文本输入。
  const hasShortcutModifier = Boolean(modifiers.ctrl || modifiers.meta || modifiers.alt)

  // 通用键（Enter/Tab/…）走 KEY_CODES 表；keyDown 仅 Space 需要文本（产生空格），
  // 且 ctrl/meta/alt 组合下同样无 text（ctrl+Space 是 IME 切换等快捷键，不能当文本输入）；
  // keyUp 一律无 text。
  const KEY_CODES = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27],
    ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    Backspace: ['Backspace', 8], Delete: ['Delete', 46], Insert: ['Insert', 45], Home: ['Home', 36], End: ['End', 35],
    PageDown: ['PageDown', 34], PageUp: ['PageUp', 33], CapsLock: ['CapsLock', 20], Space: ['Space', 32],
    F1: ['F1', 112], F2: ['F2', 113], F3: ['F3', 114], F4: ['F4', 115],
    F5: ['F5', 116], F6: ['F6', 117], F7: ['F7', 118], F8: ['F8', 119],
    F9: ['F9', 120], F10: ['F10', 121], F11: ['F11', 122], F12: ['F12', 123],
  }
  if (KEY_CODES[key]) {
    const [code, vkc] = KEY_CODES[key]
    const keyDown = { type: 'keyDown', key: String(key), code, modifiers: mod, windowsVirtualKeyCode: vkc }
    if (key === 'Space' && !hasShortcutModifier) {
      keyDown.text = ' '
      keyDown.unmodifiedText = ' '
    }
    return [
      keyDown,
      { type: 'keyUp', key: String(key), code, modifiers: mod, windowsVirtualKeyCode: vkc },
    ]
  }

  if (key.length === 1) {
    const upper = key.toUpperCase()
    const isLetter = /[a-z]/i.test(key)
    const isDigit = /[0-9]/.test(key)
    const baseOfShifted = SHIFT_TO_BASE[key] // 输入本身是 shift 后符号（'!'/'_'/'{'…）时对应的底位字符

    // key/code/vkc 定位物理键：字母 KeyX + 大写 ASCII；数字 DigitN；主区符号映射到底位键的
    // code/VKC（'!' → Digit1/49，'_' → Minus/189）；其余字符 code 退化为字符本身。
    let keyAttr = key
    let code = key
    let vkc = upper.charCodeAt(0)
    if (isLetter) {
      keyAttr = modifiers.shift ? upper : key
      code = 'Key' + upper
    } else if (isDigit) {
      code = 'Digit' + key
      vkc = key.charCodeAt(0)
    } else if (baseOfShifted !== undefined || BASE_TO_SHIFT[key] !== undefined) {
      const physical = baseOfShifted !== undefined ? baseOfShifted : key
      if (/[0-9]/.test(physical)) {
        code = 'Digit' + physical
        vkc = physical.charCodeAt(0)
      } else {
        code = SYMBOL_KEYS[physical][0]
        vkc = SYMBOL_KEYS[physical][1]
      }
    }

    const base = { key: keyAttr, code, modifiers: mod, windowsVirtualKeyCode: vkc }
    // keyDown 的 text 只在无 ctrl/meta/alt 且可打印时产生；keyUp 永不带 text（对照 puppeteer Input.up）。
    if (!hasShortcutModifier && key.charCodeAt(0) >= 32) {
      if (isDigit && modifiers.shift) {
        // 底位数字 + shift：text 为 shift 后符号（shift+'1' → '!'）；
        // unmodifiedText 为不按 shift 时的字符（CDP 定义「without modifiers」），即底位 '1'。
        base.text = BASE_TO_SHIFT[key]
        base.unmodifiedText = key
      } else if (baseOfShifted !== undefined) {
        // 输入本身是 shift 后符号（'!'，无论是否带 shift 修饰）：text 为符号，unmodifiedText 为底位字符。
        base.text = key
        base.unmodifiedText = baseOfShifted
      } else if (modifiers.shift && BASE_TO_SHIFT[key] !== undefined) {
        // 底位符号 + shift（'-' + shift → '_'）：text 为 shift 后符号，unmodifiedText 为底位 '-'。
        base.text = BASE_TO_SHIFT[key]
        base.unmodifiedText = key
      } else {
        // 普通字符：shift+字母 → 大写；其余就是字符本身；unmodifiedText 为不按 shift 的形式。
        base.text = isLetter && modifiers.shift ? upper : key
        base.unmodifiedText = isLetter ? key.toLowerCase() : key
      }
    }
    return [
      { type: 'keyDown', ...base },
      { type: 'keyUp', key: base.key, code: base.code, modifiers: base.modifiers, windowsVirtualKeyCode: base.windowsVirtualKeyCode },
    ]
  }

  // 其他多字符键名（未知键）：退化为键名本身，无 text（不可知键名 vkc=0 可接受）。
  return [
    { type: 'keyDown', key: String(key), code: String(key), modifiers: mod, windowsVirtualKeyCode: 0 },
    { type: 'keyUp', key: String(key), code: String(key), modifiers: mod, windowsVirtualKeyCode: 0 },
  ]
}

/** 按键：通用键（Enter/Tab/Escape/方向键…）或单字符；可选 ctrl/alt/meta/shift 修饰。 */
export async function pressKey(client, key, modifiers = {}) {
  for (const ev of buildKeyEvent(String(key), modifiers)) {
    await client.send('Input.dispatchKeyEvent', ev)
  }
}

/** 拖拽（鼠标按下 → 分段移动 → 释放）。适用滑块/自定义拖拽；原生 HTML5 dragstart/drop 未覆盖。 */
export async function drag(client, fromTarget, toTarget) {
  const from = await resolvePoint(client, fromTarget)
  const to = await resolvePoint(client, toTarget)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  const steps = 8
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + (to.x - from.x) * (i / steps))
    const y = Math.round(from.y + (to.y - from.y) * (i / steps))
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
}

// ===== 等待：轮询 selector 出现或页面文本出现 =====
export async function waitFor(client, { selector, text, timeoutMs }) {
  if (!selector && !text) {
    throw new Error('browser: wait_for 需要 selector 或 text 至少一个')
  }
  const deadline = Date.now() + (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000)
  for (;;) {
    if (selector) {
      const found = await evaluate(client, '!!document.querySelector(' + JSON.stringify(selector) + ')')
      if (found) return { found: 'selector' }
    }
    if (text) {
      const bodyText = await evaluate(client, 'document.body ? document.body.innerText : ""')
      if (typeof bodyText === 'string' && bodyText.includes(String(text))) return { found: 'text' }
    }
    if (Date.now() > deadline) throw new Error('browser: wait_for 超时，未等到 ' + (selector ? 'selector ' + selector : '文本 "' + text + '"'))
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ===== 对话框：接受/拒绝当前 JS dialog（alert/confirm/prompt）=====
// 前置：连接已 Page.enable（session.acquire 负责）——对话框打开会阻塞页面渲染线程，
// 阻塞期间的 Page.enable 会挂起，故这里绝不再 enable，只发 handleJavaScriptDialog。
export async function handleDialog(client, accept, promptText) {
  try {
    await client.send('Page.handleJavaScriptDialog', {
      accept: accept !== false,
      ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
    })
    return { handled: true }
  } catch (error) {
    throw new Error('browser: 当前没有打开的 JS 对话框（或已处理）：' + (error?.message ?? String(error)))
  }
}

// ===== 文件上传：给 <input type=file> 设置本地文件路径 =====
export async function setFiles(client, target, filePaths) {
  if (target.ref) {
    const backendNodeId = await refToBackendNodeId(client, target.ref)
    await client.send('DOM.setFileInputFiles', { files: filePaths, backendNodeId })
    return { uploaded: filePaths.length }
  }
  if (target.selector) {
    const doc = await client.send('DOM.getDocument', { depth: -1, pierce: true })
    const node = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: target.selector })
    if (!node.nodeId) throw new Error('browser: file_upload 未命中 <input type=file> 元素')
    await client.send('DOM.setFileInputFiles', { files: filePaths, nodeId: node.nodeId })
    return { uploaded: filePaths.length }
  }
  throw new Error('browser: file_upload 需要 ref 或 selector 定位 <input type=file>')
}

// ===== cookies =====
export async function getCookies(client, urls) {
  const res = await client.send('Network.getCookies', urls && urls.length ? { urls } : {})
  return Array.isArray(res.cookies) ? res.cookies : []
}

export async function deleteCookies(client, name, url) {
  // 有 name → deleteCookies（带 name/url 限定）；无 name → clearBrowserCookies 清全部
  // （deleteCookies 的 name 是必填参数，空参会被 Chrome 以 Invalid parameters 拒绝）。
  if (name) {
    await client.send('Network.deleteCookies', { name: String(name), ...(url ? { url } : {}) })
  } else {
    await client.send('Network.clearBrowserCookies')
  }
}
