// session.mjs — driver 长驻会话（阶段①观察复用；阶段②动作共享同一会话层）。
//
// 与 browser-control 的 CDP 连接池同思路：一次 spawn 跨 tool call 复用，省掉每调用
// 冷启动 Swift runtime 的开销；请求-应答按 id 配对；崩溃/超时自动回收，下次调用重拉。
//
// 生命周期归属：proc 属于当前 Fiber（stop 时 closeAll），插件卸载不杀不掉的子进程。
//
// 健壮性约定（2026-08-31 修复）：
//   - stdin 挂 'error' 处理器（EPIPE 等）：driver 死后继续写会炸 unhandled 'error'
//     事件把 DSH 宿主进程带崩——错误必须路由进所有 pending reject 并回收会话。
//   - 写背压：stdin.write 返回 false 时等 'drain' 再发下一条，防止大响应把管道内存打爆；
//     闸门等待与请求定时器共享同一总预算并响应 AbortSignal（F11），闸门超时判死会话。
//   - kill 升级：SIGTERM 后 1500ms 仍存活 → SIGKILL；超时回收与 closeAll 都保留升级
//     定时器（F6）——忽略 SIGTERM 的卡死 driver 一定会被 SIGKILL，包括显式关闭路径。
//   - 迟到退出保护：旧进程的 'exit' 只在它仍是当前会话时才回收（超时换新后旧进程
//     迟到退出不得误删新会话）。

import { spawn } from 'node:child_process'

const sessions = new Map() // binary -> { proc, seq, pending: Map, stderrTail, ... }

const KILL_ESCALATION_MS = 1500

function stderrTailOf(entry) {
  return entry ? entry.stderrTail.slice(-400) : ''
}

/**
 * v0.2.0 错误信封：driver 应答的 code/retryable/recovery 是稳定字段（WINDOW_GONE /
 * WINDOW_TRANSIENT / INPUT_TARGET_NOT_FOCUSED…），折进 Error message 前缀供模型自愈。
 * 无 code 的旧式应答保持原样（纯 error 文本，session 层测试依赖该形状不变）。
 */
function driverErrorFrom(reply) {
  let msg = String(reply.error ?? 'driver error')
  if (typeof reply.code === 'string' && reply.code) msg = '[' + reply.code + '] ' + msg
  const extra = []
  if (reply.retryable === true) extra.push('retryable')
  if (typeof reply.recovery === 'string' && reply.recovery) extra.push('recovery: ' + reply.recovery)
  if (extra.length) msg += ' (' + extra.join('; ') + ')'
  return new Error(msg)
}

/** reject 全部 pending（killEntry 与 stdin error 共用的兜底路径）。 */
function failAllPending(entry, message) {
  for (const [, p] of entry.pending) {
    try { p.reject(new Error(message)) } catch { /* noop */ }
  }
  entry.pending.clear()
}

/** 中止 kill：先 SIGTERM；1500ms 宽限后仍存活 → SIGKILL。定时器在自然退出时清理。 */
function killEntry(entry, reason) {
  if (!entry || entry.closed) return
  entry.closed = true
  failAllPending(entry, 'driver session closed: ' + reason)
  try { entry.proc.kill('SIGTERM') } catch { /* already dead */ }
  if (!entry.killTimer) {
    entry.killTimer = setTimeout(() => {
      entry.killTimer = null
      try {
        if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
          entry.proc.kill('SIGKILL')
        }
      } catch { /* already dead */ }
    }, KILL_ESCALATION_MS)
    entry.killTimer.unref?.()
  }
}

/** 等待 stdin 排空（write 返回 false 时的背压闸）；error/close 也放行，绝不永久挂起。 */
function drainGate(entry) {
  if (!entry.draining) return Promise.resolve()
  return entry.draining
}

function armDrainGate(entry) {
  if (entry.draining) return
  const stream = entry.proc.stdin
  entry.draining = new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done)
      stream.off('error', done)
      stream.off('close', done)
      entry.draining = null
      resolve()
    }
    stream.once('drain', done)
    stream.once('error', done)
    stream.once('close', done)
  })
}

export async function acquire(binary, timeoutMs) {
  const existing = sessions.get(binary)
  if (existing && !existing.closed) return existing

  const entry = {
    proc: null, seq: 0, pending: new Map(), stderrTail: '', closed: false, buffer: '',
    draining: null, killTimer: null,
  }
  entry.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })

  entry.proc.stdout.on('data', (d) => {
    entry.buffer += d
    let nl
    while ((nl = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, nl)
      entry.buffer = entry.buffer.slice(nl + 1)
      if (!line.trim()) continue
      let reply
      try { reply = JSON.parse(line) } catch { continue } // 畸形行忽略（driver 日志泄漏等）
      const key = String(reply.id)
      const p = entry.pending.get(key)
      if (p) {
        entry.pending.delete(key)
        if (reply.ok) p.resolve(reply.result)
        else p.reject(driverErrorFrom(reply))
      }
      // 无配对 id 的应答直接丢弃（旧会话残留/畸形 id），不报错。
    }
  })

  entry.proc.stderr.on('data', (d) => {
    entry.stderrTail = (entry.stderrTail + d).slice(-2000)
  })

  entry.proc.stdin.on('error', (err) => {
    // B1：EPIPE 等写错误是「driver 已死我们还在写」的信号。不处理会以 unhandled
    // 'error' 事件形式把宿主进程带崩；这里路由进所有 pending reject 并回收会话。
    if (!entry.closed) killEntry(entry, 'stdin error: ' + err.message)
    if (sessions.get(binary) === entry) sessions.delete(binary)
  })

  entry.proc.on('exit', (code) => {
    // B3：只回收仍登记在案的自己——超时回收后旧进程迟到退出时，sessions.get(binary)
    // 已是新 entry，绝不能误删新会话。
    const wasClosed = entry.closed
    entry.closed = true
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null }
    if (sessions.get(binary) === entry) sessions.delete(binary)
    for (const [, p] of entry.pending) {
      try { p.reject(new Error('driver exited (code ' + code + ')' + (wasClosed ? '' : '; stderr: ' + entry.stderrTail.slice(-300)))) } catch { /* noop */ }
    }
    entry.pending.clear()
  })

  entry.proc.on('error', (err) => {
    killEntry(entry, 'spawn error: ' + err.message)
    if (sessions.get(binary) === entry) sessions.delete(binary)
  })

  sessions.set(binary, entry)
  return entry
}

/**
 * 发一条请求；timeoutMs 内无应答 → 拒绝并回收会话（fail-closed，下次调用重拉新进程）。
 * options.signal（AbortSignal，可选）：中止时同样拒绝并回收会话。
 * F11：drain 闸门等待与请求定时器共享同一总预算（进 call 时 deadline = now + timeoutMs），
 * 闸门等待响应 signal——中止时立刻拒绝且不写；闸门超时同样判死会话（killEntry）。
 */
export async function call(binary, op, args, timeoutMs, options = {}) {
  const entry = await acquire(binary, timeoutMs)
  if (entry.closed) throw new Error('driver session closed (acquire race): ' + binary)
  const signal = options.signal
  if (signal?.aborted) {
    throw new Error('driver op=' + op + ' aborted before write: ' + abortReason(signal))
  }
  entry.seq += 1
  const id = entry.seq
  const key = String(id)
  // F11：整条请求（drain 等待 + 应答等待）共享一个 deadline。
  const deadline = Date.now() + timeoutMs

  // B2/F11：上一条写触发的背压未排空时，先等 drain 再发（管道满时写会积压在用户侧内存）。
  // 闸门等待受三个约束：①计入总预算（最多到 deadline）；②响应 signal（中止立刻拒绝且不写）；
  // ③超时判死会话——从不排空 stdin 的 driver 已坏，留着只会让后续请求连环超时。
  if (entry.draining) {
    let gateTimer
    let onGateAbort
    try {
      await new Promise((resolveGate, rejectGate) => {
        const budget = Math.max(0, Math.min(deadline - Date.now(), timeoutMs))
        gateTimer = setTimeout(() => {
          rejectGate(new Error('driver op=' + op + ' timeout: stdin 背压未排空（driver 不读 stdin？）after ' + timeoutMs + 'ms'))
        }, budget)
        onGateAbort = () => {
          rejectGate(new Error('driver op=' + op + ' aborted during drain: ' + abortReason(signal)))
        }
        signal?.addEventListener?.('abort', onGateAbort, { once: true })
        drainGate(entry).then(resolveGate, rejectGate)
      })
    } catch (gateErr) {
      if (signal?.aborted) {
        throw gateErr
      }
      killEntry(entry, 'drain gate ' + (gateErr?.message ?? 'failed') + ' on op=' + op)
      if (sessions.get(binary) === entry) sessions.delete(binary)
      throw gateErr
    } finally {
      clearTimeout(gateTimer)
      signal?.removeEventListener?.('abort', onGateAbort)
    }
  }
  if (entry.closed) throw new Error('driver session closed: ' + binary + ' (before write)')

  return await new Promise((resolve, reject) => {
    const settleFail = (message) => {
      if (!entry.pending.has(key)) return
      entry.pending.delete(key)
      cleanup()
      reject(new Error(message))
    }
    // F11：请求定时器只拿总预算的剩余部分（drain 等待已消费掉一部分时相应缩短）。
    const remaining = Math.max(0, deadline - Date.now())
    const timer = setTimeout(() => {
      entry.pending.delete(key)
      cleanup()
      killEntry(entry, 'timeout on op=' + op + ' after ' + timeoutMs + 'ms')
      if (sessions.get(binary) === entry) sessions.delete(binary)
      reject(new Error('driver op=' + op + ' timeout after ' + timeoutMs + 'ms'))
    }, remaining)
    const onAbort = () => {
      entry.pending.delete(key)
      cleanup()
      killEntry(entry, 'aborted on op=' + op + ': ' + abortReason(signal))
      if (sessions.get(binary) === entry) sessions.delete(binary)
      reject(new Error('driver op=' + op + ' aborted: ' + abortReason(signal)))
    }
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    entry.pending.set(key, {
      resolve: (v) => { cleanup(); resolve(v) },
      reject: (e) => { cleanup(); reject(e) },
    })
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const payload = JSON.stringify({ id, op, args }) + '\n'
    // B2：write 带回调（EPIPE 等写错时精确 reject 本条；进程级兜底在 stdin 'error' 处理器）。
    const backpressured = entry.proc.stdin.write(payload, (err) => {
      if (err) settleFail('driver stdin write failed: ' + err.message)
    })
    if (!backpressured) armDrainGate(entry)
  })
}

function abortReason(signal) {
  return signal && signal.reason !== undefined ? String(signal.reason) : 'signal aborted'
}

/** 关闭某个 binary 的会话；省略 binary = 全关（插件卸载时）。
 * F6：closeAll 不再清除 kill 升级定时器——SIGTERM 被忽略的卡死 driver 在会话 map 清空后
 * 仍由宽限期后的 SIGKILL 兜底回收（定时器 unref 不挂事件循环，进程自然退出时由 exit
 * 处理器清理）。此前这里 clearTimeout 会让忽略 SIGTERM 的 driver 逃过回收变成泄漏进程。 */
export function closeAll(binary) {
  if (binary) {
    const entry = sessions.get(binary)
    if (entry) {
      killEntry(entry, 'closeAll')
      sessions.delete(binary)
    }
    return
  }
  for (const [, entry] of sessions) killEntry(entry, 'closeAll')
  sessions.clear()
}

export function sessionStateForTest() {
  const pids = []
  for (const [, entry] of sessions) {
    try { if (entry.proc?.pid) pids.push(entry.proc.pid) } catch { /* no pid */ }
  }
  return { count: sessions.size, pids }
}

export { stderrTailOf }
