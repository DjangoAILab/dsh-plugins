// session.mjs — 持久连接池（按 targetId 缓存 CdpClient），替代「每次工具调用重连」。
// 解锁三件事：① 对话框跨 tool call 处理（Page.handleJavaScriptDialog 需要同一连接里 Page.enable 过 +
// 对话框打开事件被追踪）；② console/network 事件缓冲（重连式只能看到连接后的事件，这里跨调用累积）；
// ③ 消除每次操作的 WebSocket 握手开销。
//
// 生命周期：acquire 惰性建立；close_page 时 closeSession；插件 dispose 时 closeAll。
// 并发：宿主会并行调度 isConcurrencySafe=true 的工具，同一 targetId 的并发 acquire
// 靠 pending Map 去重——后到者 await 同一条 in-flight 建连 promise，绝不重复建连。

import { CdpClient, listTargets, CdpError } from './cdp.mjs'

const MAX_BUFFER = 200
const pool = new Map() // targetId -> { client, console, network }
const pending = new Map() // targetId -> Promise<entry>（in-flight 建连去重）
// 被 closeSession/closeAll 关闭时仍在建连的 targetId -> 那条 in-flight promise。
// 记 promise 身份而非只记 key：标记只对「close 时看到的那一条建连」生效，绝不误杀
// 后续同 key 的全新建连（promise 落地链会按身份消费并清除自己的标记）。
const discarded = new Map()

async function resolveTarget(endpoint, targetId) {
  const targets = await listTargets(endpoint)
  const list = Array.isArray(targets) ? targets : []
  // 空串等同省略：走「首个 page target」分支（`targetId !== undefined` 判定会让空串
  // 落进按 id 查找分支而永远找不到）。
  const hasId = targetId !== undefined && targetId !== ''
  const target = hasId
    ? list.find((t) => t && t.id === targetId && t.webSocketDebuggerUrl)
    : list.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
  if (!target) {
    throw new CdpError('未在 ' + endpoint + ' 找到 target（先 browser_pages 拿最新 id，或 Chrome 已关）', 'CDP_NO_TARGET')
  }
  return target
}

/** 建连路径：open + enable 三个域 + 挂事件缓冲，返回**未入池**的连接条目。
 * 失败时关连接再抛，绝不泄漏半开 WebSocket；入池与否由 acquire 依据 discarded 标记决定。 */
async function buildEntry(endpoint, key, commandTimeoutMs) {
  const target = await resolveTarget(endpoint, key)
  const client = new CdpClient(target.webSocketDebuggerUrl, { commandTimeoutMs })
  try {
    await client.open()
    // 关键域：Page 供对话框、Runtime 供 console/evaluate、Network 供网络缓冲
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Network.enable')
  } catch (error) {
    try { client.close() } catch { /* ignore */ }
    throw error
  }
  const entry = { client, console: [], network: [] }
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
  return entry
}

/**
 * 取得（必要时新建）targetId 对应的连接条目，并返回。控制面由调用方决定何时 closeSession。
 * 同一 targetId 并发调用共享同一条 in-flight 建连 promise（去重，不重复建连）。
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
  if (entry) return entry
  const inflight = pending.get(key)
  if (inflight) return inflight
  // creating 在自身初始化器里不可引用（TDZ），故 discarded 检查放在 .then 链里按 promise
  // 身份后置比对：closeSession/closeAll 标记的是「close 时看到的那条 in-flight」，仅该条
  // 建连落地时被丢弃（不复活孤儿连接）；close 之后启动的全新建连不受标记影响。
  const creating = buildEntry(endpoint, key, commandTimeoutMs)
    .then((entry) => {
      if (discarded.get(key) === creating) {
        discarded.delete(key)
        try { entry.client.close() } catch { /* ignore */ }
        throw new CdpError('target 连接在建连期间已被关闭（targetId=' + key + '），请重新 acquire', 'CDP_SESSION_CLOSED')
      }
      pool.set(key, entry)
      return entry
    })
    .catch((error) => {
      // 建连失败（含 discarded 丢弃分支）：清掉该 key 的 discarded 标记，避免污染后续全新建连。
      if (discarded.get(key) === creating) discarded.delete(key)
      throw error
    })
    .finally(() => {
      pending.delete(key)
    })
  pending.set(key, creating)
  return creating
}

/** 清空指定 targetId 的 console/network 观测缓冲（navigate/reload/历史导航换文档后调用）。 */
export function resetBuffers(targetId) {
  const entry = pool.get(targetId)
  if (!entry) return
  entry.console.length = 0
  entry.network.length = 0
}

/** 解析 targetId（省略时 = 首个 page target）为池 key，供工具层在换文档后调 resetBuffers。 */
export async function resolveTargetId(endpoint, targetId) {
  const target = await resolveTarget(endpoint, targetId)
  return target.id
}

/** 关闭并移除指定 targetId 的连接（browser_close_page 用）。若该 key 还有 in-flight 建连，
 * 按 promise 身份标记 discarded：建连落地时直接丢弃、不入池（否则 pending 完成后 set 会
 * 复活孤儿连接）。注意：close 后立即对同一 targetId acquire 会先命中那条注定被丢弃的
 * in-flight promise 吃一次 CDP_SESSION_CLOSED，重试即成功（新建连不受标记影响）。 */
export function closeSession(targetId) {
  const entry = pool.get(targetId)
  if (entry) {
    try { entry.client.close() } catch { /* ignore */ }
    pool.delete(targetId)
  }
  const inflight = pending.get(targetId)
  if (inflight) discarded.set(targetId, inflight)
}

/** 关闭全部连接（插件 dispose 用）。语义同 closeSession：所有 in-flight 建连一并不入池。 */
export function closeAll() {
  for (const entry of pool.values()) {
    try { entry.client.close() } catch { /* ignore */ }
  }
  pool.clear()
  for (const [key, inflight] of pending) discarded.set(key, inflight)
}
