// session.mjs — 持久连接池（按 targetId 缓存 CdpClient），替代「每次工具调用重连」。
// 解锁三件事：① 对话框跨 tool call 处理（Page.handleJavaScriptDialog 需要同一连接里 Page.enable 过 +
// 对话框打开事件被追踪）；② console/network 事件缓冲（重连式只能看到连接后的事件，这里跨调用累积）；
// ③ 消除每次操作的 WebSocket 握手开销。
//
// 生命周期：acquire 惰性建立；close_page 时 closeSession；插件 dispose 时 closeAll。

import { CdpClient, listTargets, CdpError } from './cdp.mjs'

const MAX_BUFFER = 200
const pool = new Map() // targetId -> { client, console, network }

async function resolveTarget(endpoint, targetId) {
  const targets = await listTargets(endpoint)
  const list = Array.isArray(targets) ? targets : []
  const target = targetId !== undefined
    ? list.find((t) => t && t.id === targetId && t.webSocketDebuggerUrl)
    : list.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
  if (!target) {
    throw new CdpError('未在 ' + endpoint + ' 找到 target（先 browser_pages 拿最新 id，或 Chrome 已关）', 'CDP_NO_TARGET')
  }
  return target
}

/**
 * 取得（必要时新建）targetId 对应的连接条目，并返回。控制面由调用方决定何时 closeSession。
 * @returns {Promise<{ client: CdpClient, console: Array<object>, network: Array<object> }>}
 */
export async function acquire(endpoint, targetId, commandTimeoutMs) {
  const target = await resolveTarget(endpoint, targetId)
  const key = target.id
  let entry = pool.get(key)
  if (entry && entry.client.closed) {
    pool.delete(key)
    entry = undefined
  }
  if (!entry) {
    const client = new CdpClient(target.webSocketDebuggerUrl, { commandTimeoutMs })
    await client.open()
    // 关键域：Page 供对话框、Runtime 供 console/evaluate、Network 供网络缓冲
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Network.enable')
    entry = { client, console: [], network: [] }
    client.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => (a && (a.value !== undefined ? a.value : a.description)) ?? '').join(' ')
      entry.console.push({ type: p.type || 'log', text: String(text).slice(0, 2000) })
      if (entry.console.length > MAX_BUFFER) entry.console.shift()
    })
    client.on('Network.requestWillBeSent', (p) => {
      entry.network.push({ id: p.requestId, url: p.request && p.request.url, method: p.request && p.request.method, status: 0 })
      if (entry.network.length > MAX_BUFFER) entry.network.shift()
    })
    client.on('Network.responseReceived', (p) => {
      const item = entry.network.find((n) => n.id === p.requestId)
      if (item) item.status = p.response && p.response.status
    })
    pool.set(key, entry)
  }
  return entry
}

/** 关闭并移除指定 targetId 的连接（browser_close_page 用）。 */
export function closeSession(targetId) {
  const entry = pool.get(targetId)
  if (entry) {
    try { entry.client.close() } catch { /* ignore */ }
    pool.delete(targetId)
  }
}

/** 关闭全部连接（插件 dispose 用）。 */
export function closeAll() {
  for (const entry of pool.values()) {
    try { entry.client.close() } catch { /* ignore */ }
  }
  pool.clear()
}