// scripts/cdp-smoke.mjs
// 真实 Chrome 端到端 smoke：连 CDP 端点 → navigate 到 data: 测试页 → snapshot（a11y + ref）
// → 按 ref 点击按钮 → 按 ref 向输入框 type → extract。验证 cdp.mjs / actions.mjs / snapshot.mjs
// 的协议假设（getFullAXTree / DOM.getBoxModel / dispatchMouseEvent / insertText）。
//
// 用法：node scripts/cdp-smoke.mjs [endpoint]   （默认 http://127.0.0.1:9222）
// 前置：Chrome 以 --remote-debugging-port=9222 启动。

import { CdpClient, listTargets, evaluate, waitForLoad } from '../src/cdp.mjs'
import { getNodes, snapshot, resolvePoint, mouseClick, typeText } from '../src/actions.mjs'

const endpoint = process.argv[2] || 'http://127.0.0.1:9222'

const TEST_HTML =
  '<html><head><title>smoke</title></head><body>' +
  '<h1 id="title">Hello Browser</h1>' +
  '<input id="q" placeholder="Search">' +
  '<button id="go" onclick="document.getElementById(\'clicked\').textContent=\'YES\'">Go</button>' +
  '<span id="clicked">NO</span>' +
  '</body></html>'

const url = 'data:text/html,' + encodeURIComponent(TEST_HTML)

function assert(cond, msg) {
  if (!cond) throw new Error('SMOKE FAIL: ' + msg)
}

function refOf(refs, backendDOMNodeId) {
  for (const [index, id] of refs.entries()) {
    if (id === backendDOMNodeId) return '@' + index
  }
  return undefined
}

const targets = await listTargets(endpoint)
console.log('[ok] listTargets: ' + targets.length + ' page target(s)')

const client = await CdpClient.connect(endpoint)
try {
  await client.send('Page.navigate', { url })
  await waitForLoad(client)
  const title = await evaluate(client, 'document.title')
  assert(title === 'smoke', 'title should be "smoke", got "' + title + '"')
  console.log('[ok] navigate + waitForLoad → title "smoke"')

  const { text, refs } = await snapshot(client)
  assert(text.includes('Hello Browser'), 'snapshot should contain heading text')
  assert(refs.size >= 3, 'snapshot refs should be >=3, got ' + refs.size)
  console.log('[ok] snapshot: ' + refs.size + ' refs')
  console.log('--- snapshot preview ---')
  console.log(text.split('\n').slice(0, 10).join('\n'))

  // 按 ref 点击按钮（ref → backendDOMNodeId → DOM.getBoxModel → 鼠标事件）。
  const nodes = await getNodes(client)
  const btn = nodes.find((n) => n.role && n.role.value === 'button' && n.name && n.name.value === 'Go')
  assert(btn && btn.backendDOMNodeId, 'button a11y node with backendDOMNodeId')
  const btnRef = refOf(refs, btn.backendDOMNodeId)
  assert(btnRef, 'button should carry a ref in snapshot')
  const btnPoint = await resolvePoint(client, { ref: btnRef })
  await mouseClick(client, btnPoint.x, btnPoint.y)
  const clicked = await evaluate(client, "document.getElementById('clicked').textContent")
  assert(clicked === 'YES', '#clicked should become "YES" after ref click, got "' + clicked + '"')
  console.log('[ok] click via ref ' + btnRef + ' → #clicked=YES')

  // 按 ref 向输入框 type（ref → 聚焦 + Input.insertText）。
  const input = nodes.find((n) => n.role && n.role.value === 'textbox')
  assert(input && input.backendDOMNodeId, 'textbox a11y node with backendDOMNodeId')
  const inputRef = refOf(refs, input.backendDOMNodeId)
  assert(inputRef, 'textbox should carry a ref in snapshot')
  const inputPoint = await resolvePoint(client, { ref: inputRef })
  await mouseClick(client, inputPoint.x, inputPoint.y)
  await typeText(client, 'hello123')
  const value = await evaluate(client, "document.getElementById('q').value")
  assert(value === 'hello123', 'input value should be "hello123", got "' + value + '"')
  console.log('[ok] type via ref ' + inputRef + ' → input.value="hello123"')

  // selector 分支（getBoundingClientRect 路径）不报错即可。
  const selPoint = await resolvePoint(client, { selector: '#go' })
  assert(Number.isFinite(selPoint.x) && Number.isFinite(selPoint.y), 'selector resolve should yield a point')
  console.log('[ok] resolvePoint via selector #go → (' + selPoint.x + ',' + selPoint.y + ')')

  console.log('\nSMOKE OK: navigate / snapshot / click(ref) / type(ref) / selector 全部通过。')
} finally {
  client.close()
}