import { test } from 'node:test'
import assert from 'node:assert/strict'

// session.mjs 依赖 cdp.mjs 的 CdpClient（全局 WebSocket）与 listTargets（全局 fetch）。
// 不连真 Chrome 的测法：注入可编程假 WebSocket 与假 fetch，让 acquire 全链路（解析 target →
// 握手 → Page/Runtime/Network.enable → 池化）走假件，验证 in-flight 去重 / 失败清理 / 缓冲重置。

class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.listeners = new Map()
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event)
  }
  send(data) {
    this.sent.push(data)
    const msg = JSON.parse(data)
    if (msg.method && msg.method.endsWith('.enable')) {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) }))
    }
  }
  close() {
    this.readyState = 3
    this.closed = true
    this.emit('close', {})
  }
  openOk() {
    this.readyState = 1
    this.emit('open', {})
  }
}

/** 全局 fake fetch：返回一个 page target；可选对 enable 回错误。 */
function installFakeFetch(targetId) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{ id: targetId, type: 'page', url: 'http://x/', title: 'x', webSocketDebuggerUrl: 'ws://fake/' + targetId }],
  })
}

/** 自动握手的假 WebSocket：构造后 5ms openOk。 */
class AutoOpenWebSocket extends FakeWebSocket {
  constructor(url) {
    super(url)
    setTimeout(() => this.openOk(), 5)
  }
}

async function loadSession() {
  return import('../src/session.mjs')
}

test('session: concurrent acquire for same targetId dedupes to one connection', async () => {
  installFakeFetch('T1')
  globalThis.WebSocket = AutoOpenWebSocket
  FakeWebSocket.instances = []
  const session = await loadSession()

  try {
    const [e1, e2, e3] = await Promise.all([
      session.acquire('http://fake', 'T1', 5000),
      session.acquire('http://fake', 'T1', 5000),
      session.acquire('http://fake', 'T1', 5000),
    ])
    // 后到者 await 同一条 in-flight promise → 同一条目、只建一条连接。
    assert.equal(e1, e2)
    assert.equal(e2, e3)
    assert.equal(FakeWebSocket.instances.length, 1)
    // 顺序再取：命中池，不新建。
    const again = await session.acquire('http://fake', 'T1', 5000)
    assert.equal(again, e1)
    assert.equal(FakeWebSocket.instances.length, 1)
  } finally {
    session.closeAll()
  }
})

test('session: enable failure closes the half-open client and does not pool it', async () => {
  installFakeFetch('T2')
  // Network.enable 回协议错误 → acquire 失败，且半开连接必须被 close。
  globalThis.WebSocket = class extends AutoOpenWebSocket {
    send(data) {
      const msg = JSON.parse(data)
      if (msg.method === 'Network.enable') {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ id: msg.id, error: { code: -32601, message: 'not supported' } }),
        }))
        return
      }
      super.send(data)
    }
  }
  const session = await loadSession()

  await assert.rejects(() => session.acquire('http://fake', 'T2', 5000), /not supported/)
  // 半开连接已关、未入池、pending 已清：再取走全新建连（同样失败），不拿到 closed entry。
  await assert.rejects(() => session.acquire('http://fake', 'T2', 5000), /not supported/)
  assert.ok(FakeWebSocket.instances.every((w) => w.closed), 'no leaked half-open WebSocket')
  session.closeAll()
})

test('session: resetBuffers clears console/network, missing entry is a no-op', async () => {
  installFakeFetch('T3')
  globalThis.WebSocket = AutoOpenWebSocket
  const session = await loadSession()

  try {
    const entry = await session.acquire('http://fake', 'T3', 5000)
    entry.console.push({ type: 'log', text: 'old' })
    entry.network.push({ id: '1', url: 'http://x/a', method: 'GET', status: 200 })
    session.resetBuffers('T3')
    assert.equal(entry.console.length, 0)
    assert.equal(entry.network.length, 0)
    // 条目不存在的 targetId：静默忽略，不抛。
    assert.doesNotThrow(() => session.resetBuffers('no-such-target'))
  } finally {
    session.closeAll()
  }
})

test('session: closeSession closes and removes the entry', async () => {
  installFakeFetch('T4')
  globalThis.WebSocket = AutoOpenWebSocket
  const session = await loadSession()

  try {
    const entry = await session.acquire('http://fake', 'T4', 5000)
    assert.equal(entry.client.closed, false)
    session.closeSession('T4')
    assert.equal(entry.client.closed, true)
    // 关闭后再 acquire：旧 entry 已出池，新建成功。
    const fresh = await session.acquire('http://fake', 'T4', 5000)
    assert.notEqual(fresh, entry)
  } finally {
    session.closeAll()
  }
})

test('session: resolveTargetId("") behaves like omitted (first page target)', async () => {
  // P3-1 回归锚点：空串 targetId 曾落进「按 id 查找」分支（`!== undefined`）而永远找不到。
  installFakeFetch('T5')
  globalThis.WebSocket = AutoOpenWebSocket
  const session = await loadSession()

  try {
    const id = await session.resolveTargetId('http://fake', '')
    assert.equal(id, 'T5')
    const entry = await session.acquire('http://fake', '')
    assert.equal(entry.client.closed, false)
  } finally {
    session.closeAll()
  }
})

test('session: closeSession during in-flight connect discards the entry, next acquire reconnects', async () => {
  // P3-2 回归锚点：pending 建连窗口内 closeSession，落地后不得 set 池复活孤儿连接。
  // 注意 acquire() 同步注册 pending，但 WebSocket 在后续微任务才构造——先等构造再触发。
  installFakeFetch('T6')
  FakeWebSocket.instances = [] // 清掉前面用例的实例，instance 数量断言才成立
  const gates = []
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url) {
      super(url)
      gates.push((ws) => ws.openOk())
    }
  }
  const session = await loadSession()

  try {
    const acquiring = session.acquire('http://fake', 'T6', 5000)
    // 等 buildEntry 真正构造出 WebSocket（fetch 解析在先，需让微任务跑完）。
    await new Promise((r) => setImmediate(r))
    assert.equal(FakeWebSocket.instances.length, 1)
    session.closeSession('T6') // in-flight 窗口内关闭：标记 discarded
    gates[0](FakeWebSocket.instances[0]) // 放行握手，让建连 promise 落地
    await assert.rejects(() => acquiring, /已被关闭/)
    assert.equal(FakeWebSocket.instances[0].closed, true) // 被丢弃的那条已关，未入池复活
    // 全新 acquire：全新建连，不受旧标记影响。
    const freshPromise = session.acquire('http://fake', 'T6', 5000)
    await new Promise((r) => setImmediate(r))
    gates[1](FakeWebSocket.instances[1])
    const fresh = await freshPromise
    assert.equal(fresh.client.closed, false)
    assert.equal(FakeWebSocket.instances.length, 2)
  } finally {
    session.closeAll()
  }
})

test('session: closeAll during in-flight connect discards the entry', async () => {
  installFakeFetch('T7')
  FakeWebSocket.instances = []
  const gates = []
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url) {
      super(url)
      gates.push(() => this.openOk())
    }
  }
  const session = await loadSession()

  try {
    const acquiring = session.acquire('http://fake', 'T7', 5000)
    await new Promise((r) => setImmediate(r))
    session.closeAll() // dispose 竞态：所有 in-flight 一并标记
    gates[0]()
    await assert.rejects(() => acquiring, /已被关闭/)
    assert.equal(FakeWebSocket.instances[0].closed, true)
  } finally {
    session.closeAll()
  }
})
