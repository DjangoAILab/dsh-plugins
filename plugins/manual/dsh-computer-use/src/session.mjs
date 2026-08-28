// session.mjs — driver 长驻会话（阶段①观察复用；阶段②动作共享同一会话层）。
//
// 与 browser-control 的 CDP 连接池同思路：一次 spawn 跨 tool call 复用，省掉每调用
// 冷启动 Swift runtime 的开销；请求-应答按 id 配对；崩溃/超时自动回收，下次调用重拉。
//
// 生命周期归属：proc 属于当前 Fiber（stop 时 closeAll），插件卸载不杀不掉的子进程。

import { spawn } from 'node:child_process'

const sessions = new Map() // binary -> { proc, seq, pending: Map, stderrTail }

function stderrTailOf(entry) {
  return entry ? entry.stderrTail.slice(-400) : ''
}

function killEntry(entry, reason) {
  if (!entry || entry.closed) return
  entry.closed = true
  for (const [, p] of entry.pending) {
    try { p.reject(new Error('driver session closed: ' + reason)) } catch { /* noop */ }
  }
  entry.pending.clear()
  try { entry.proc.kill() } catch { /* already dead */ }
}

export async function acquire(binary, timeoutMs) {
  const existing = sessions.get(binary)
  if (existing && !existing.closed) return existing

  const entry = { proc: null, seq: 0, pending: new Map(), stderrTail: '', closed: false, buffer: '' }
  entry.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })

  entry.proc.stdout.on('data', (d) => {
    entry.buffer += d
    let nl
    while ((nl = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, nl)
      entry.buffer = entry.buffer.slice(nl + 1)
      if (!line.trim()) continue
      let reply
      try { reply = JSON.parse(line) } catch { continue }
      const key = String(reply.id)
      const p = entry.pending.get(key)
      if (p) {
        entry.pending.delete(key)
        if (reply.ok) p.resolve(reply.result)
        else p.reject(new Error(String(reply.error ?? 'driver error')))
      }
    }
  })

  entry.proc.stderr.on('data', (d) => {
    entry.stderrTail = (entry.stderrTail + d).slice(-2000)
  })

  entry.proc.on('exit', (code) => {
    const wasClosed = entry.closed
    entry.closed = true
    sessions.delete(binary)
    for (const [, p] of entry.pending) {
      try { p.reject(new Error('driver exited (code ' + code + ')' + (wasClosed ? '' : '; stderr: ' + entry.stderrTail.slice(-300)))) } catch { /* noop */ }
    }
    entry.pending.clear()
  })

  entry.proc.on('error', (err) => {
    killEntry(entry, 'spawn error: ' + err.message)
    sessions.delete(binary)
  })

  sessions.set(binary, entry)
  return entry
}

/** 发一条请求；timeoutMs 内无应答 → 拒绝并回收会话（fail-closed，下次调用重拉新进程）。 */
export async function call(binary, op, args, timeoutMs) {
  const entry = await acquire(binary, timeoutMs)
  entry.seq += 1
  const id = entry.seq
  const key = String(id)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(key)
      killEntry(entry, 'timeout on op=' + op + ' after ' + timeoutMs + 'ms')
      sessions.delete(binary)
      reject(new Error('driver op=' + op + ' timeout after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    entry.pending.set(key, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    entry.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  })
}

/** 关闭某个 binary 的会话；省略 binary = 全关（插件卸载时）。 */
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
  return { count: sessions.size }
}
