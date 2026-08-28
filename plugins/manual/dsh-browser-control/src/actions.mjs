// CDP 动作原语：观察（a11y 树快照）、定位（ref/selector → 屏幕中心）、动作（点击/输入）。
// 刻意不 import @deepseek-ai/dsh-tools，因此既被 tools.mjs 复用，也能被 scripts/cdp-smoke.mjs
// 在真实 Chrome 上单测（验证 a11y / getBoxModel / 鼠标事件 / insertText 协议假设）。

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
    throw new Error('browser: 无效 ref @' + index + '，请先跑 browser_snapshot 拿最新 ref（页面可能已变化）')
  }
  return backendNodeId
}

/** 由 backendDOMNodeId 求元素中心点。 */
export async function backendNodeCenter(client, backendNodeId) {
  const box = await client.send('DOM.getBoxModel', { backendNodeId })
  const c = box && box.model && box.model.content
  if (!Array.isArray(c) || c.length < 8) throw new Error('browser: 该元素无盒模型（不可见或已分离）')
  return {
    x: Math.round((c[0] + c[2] + c[4] + c[6]) / 4),
    y: Math.round((c[1] + c[3] + c[5] + c[7]) / 4),
  }
}

/** 解析点击/输入目标为屏幕中心点。优先 ref（快照命中），其次 selector。 */
export async function resolvePoint(client, target) {
  if (target.ref) {
    const backendNodeId = await refToBackendNodeId(client, target.ref)
    return backendNodeCenter(client, backendNodeId)
  }
  if (target.selector) {
    const expr =
      '(() => { const el = document.querySelector(' + JSON.stringify(target.selector) + '); ' +
      'if (!el) return null; const r = el.getBoundingClientRect(); ' +
      'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()'
    const point = await evaluate(client, expr)
    if (!point) throw new Error('browser: selector 未命中元素：' + target.selector)
    return point
  }
  throw new Error('browser: 需要 ref（来自 browser_snapshot）或 selector（CSS）')
}

export async function mouseClick(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 在已聚焦元素插入纯文本（调用方先 mouseClick 聚焦目标元素）。 */
export async function typeText(client, text) {
  await client.send('Input.insertText', { text: String(text) })
}

// ===== 导航历史 =====
export async function goBack(client) {
  await evaluate(client, 'history.back()')
  await waitForLoad(client)
  await waitForAccessibility(client)
}

export async function goForward(client) {
  await evaluate(client, 'history.forward()')
  await waitForLoad(client)
  await waitForAccessibility(client)
}

export async function reload(client) {
  await client.send('Page.reload')
  await waitForLoad(client)
  await waitForAccessibility(client)
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

const KEY_CODES = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27],
  ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], Home: ['Home', 36], End: ['End', 35],
  PageDown: ['PageDown', 34], PageUp: ['PageUp', 33], F5: ['F5', 116], Space: ['Space', 32],
}

/** 按键：通用键（Enter/Tab/Escape/方向键…）或单字符；可选 ctrl/alt/meta/shift 修饰。 */
export async function pressKey(client, key, modifiers = {}) {
  const spec = KEY_CODES[key] || [key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0]
  const mod = (modifiers.ctrl ? 2 : 0) | (modifiers.alt ? 1 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0)
  const base = { key: String(key), code: spec[0], modifiers: mod, windowsVirtualKeyCode: spec[1] }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
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
  // 空 name = 清除全部（需 url 限定或全部）。
  await client.send('Network.deleteCookies', { ...(name ? { name } : {}), ...(url ? { url } : {}) })
}