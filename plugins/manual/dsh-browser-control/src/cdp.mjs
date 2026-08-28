// 极简 CDP（Chrome DevTools Protocol）客户端：经 Node 22 全局 WebSocket + fetch 连接一个
// remote-debugging 端点（Chrome/Chromium 以 --remote-debugging-port 启动），做 JSON-RPC
// 请求/响应 + 事件分发。零 npm 依赖。协议事实见 https://chromedevtools.github.io/devtools-protocol/。

const DEFAULT_TIMEOUT_MS = 15000

/** 拉取 remote-debugging 端点的 target 列表（GET /json，无需 WebSocket）。 */
export async function listTargets(endpoint) {
  const res = await fetch(endpoint + '/json')
  if (!res.ok) {
    throw new CdpError('CDP 端点不可达：' + endpoint + ' 返回 HTTP ' + res.status + '（请用 --remote-debugging-port=9222 启动 Chrome）', 'CDP_ENDPOINT_UNREACHABLE')
  }
  try {
    const targets = await res.json()
    return Array.isArray(targets) ? targets : []
  } catch {
    return []
  }
}

/** 新建 page target 并返回其 { id, url, ... }（PUT /json/new?url）。 */
export async function createTarget(endpoint, url = 'about:blank') {
  const res = await fetch(endpoint + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  if (!res.ok) throw new CdpError('新建 tab 失败：' + endpoint + ' 返回 ' + res.status, 'CDP_NEW_TARGET')
  try {
    return await res.json()
  } catch {
    throw new CdpError('新建 tab 失败：无法解析响应', 'CDP_NEW_TARGET')
  }
}

/** 关闭指定 target（GET /json/close/<id>）。 */
export async function closeTarget(endpoint, targetId) {
  const res = await fetch(endpoint + '/json/close/' + encodeURIComponent(targetId))
  if (!res.ok) throw new CdpError('关闭 tab 失败（id=' + targetId + '）：' + res.status, 'CDP_CLOSE_TARGET')
}

/** 把指定 target 提到前台（GET /json/activate/<id>；headed 模式下让人类看到该 tab）。 */
export async function activateTarget(endpoint, targetId) {
  const res = await fetch(endpoint + '/json/activate/' + encodeURIComponent(targetId))
  if (!res.ok) throw new CdpError('切换 tab 失败（id=' + targetId + '）：' + res.status, 'CDP_ACTIVATE_TARGET')
}

export class CdpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

export class CdpClient {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.ws = undefined
    this.closed = false
  }

  /** 连接端点并挑选一个 target：显式 targetId 优先（来自 browser_pages 的 id），否则取第一个 type=page。 */
  static async connect(endpoint, options = {}) {
    const type = options.type ?? 'page'
    const commandTimeoutMs = options.commandTimeoutMs
    const targetId = options.targetId
    const targets = await listTargets(endpoint)
    const list = Array.isArray(targets) ? targets : []
    const target = targetId !== undefined
      ? list.find((t) => t && t.id === targetId && t.webSocketDebuggerUrl)
      : list.find((t) => t && t.type === type && t.webSocketDebuggerUrl)
    if (!target) {
      const want = targetId !== undefined ? 'id=' + targetId : 'type=' + type
      throw new CdpError('未在 ' + endpoint + ' 找到 ' + want + ' 的 target（先跑 browser_pages 拿最新 id；Chrome 是否已开启远程调试？）', 'CDP_NO_TARGET')
    }
    const client = new CdpClient(target.webSocketDebuggerUrl, { commandTimeoutMs })
    await client.open()
    return client
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => {
        reject(new CdpError('CDP WebSocket 连接失败：' + this.wsUrl, 'CDP_WS_ERROR'))
      })
      ws.addEventListener('message', (event) => this._onMessage(event))
      ws.addEventListener('close', () => {
        this.closed = true
      })
    })
  }

  _text(data) {
    if (typeof data === 'string') return data
    if (data !== undefined && typeof data.toString === 'function') return data.toString()
    return ''
  }

  _onMessage(event) {
    let msg
    try {
      msg = JSON.parse(this._text(event.data))
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new CdpError(msg.error.message || 'CDP 命令失败', msg.error.code))
      else entry.resolve(msg.result)
      return
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method)
      if (set) {
        for (const fn of [...set]) {
          try {
            fn(msg.params || {})
          } catch {
            /* 事件回调异常不冒泡 */
          }
        }
      }
    }
  }

  send(method, params = {}, options = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new CdpError('CDP 客户端未连接', 'CDP_NOT_OPEN'))
    }
    const id = this.nextId++
    const timeout = options.timeoutMs ?? this.commandTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError('CDP 命令 ' + method + ' 超时（' + timeout + 'ms）', 'CDP_TIMEOUT'))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError('CDP 发送失败：' + String(error && error.message ? error.message : error), 'CDP_SEND_ERROR'))
      }
    })
  }

  on(event, fn) {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  close() {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    for (const entry of this.pending.values()) entry.reject(new CdpError('CDP 客户端已关闭', 'CDP_CLOSED'))
    this.pending.clear()
  }
}

/** 在页面里执行一段 JS 表达式并回传值；页面抛错转成 CdpError。 */
export async function evaluate(client, expression, options = {}) {
  const res = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    options,
  )
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'
    throw new CdpError('页面 JS 执行抛错：' + text, 'CDP_JS_EXCEPTION')
  }
  return res.result && res.result.value !== undefined ? res.result.value : undefined
}

/** 轮询 document.readyState === 'complete'（navigate 后等待加载完成）。 */
export async function waitForLoad(client, options = {}) {
  const timeout = options.timeoutMs ?? client.commandTimeoutMs
  const deadline = Date.now() + timeout
  for (;;) {
    if (Date.now() > deadline) throw new CdpError('页面加载超时（' + timeout + 'ms）', 'CDP_LOAD_TIMEOUT')
    const state = await evaluate(client, 'document.readyState', options)
    if (state === 'complete') return
    await new Promise((r) => setTimeout(r, 100))
  }
}