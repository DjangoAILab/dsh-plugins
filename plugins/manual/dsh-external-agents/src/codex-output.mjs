// dsh-external-agents codex-output.mjs
// codex CLI 输出解析（v2.4 session 连续性）：纯函数、无 ctx 依赖，便于单测。
//
// 机制事实（codex-cli 0.146.0，2026-08-31 实测，升级需复核）：
//   - `codex exec --json` 的 stdout 是纯 JSONL，日志全在 stderr。首事件
//     {"type":"thread.started","thread_id":"<uuid>"}；最终回答是最后一条
//     item.completed 且 item.type === 'agent_message' 的 item.text。
//   - 非 --json 的 banner 文本里有独立一行 `session id: <uuid>`（stderr 也有同名行）。
//   - resume <id> --json 会回显同一 thread_id（完整性校验用）。
//
// 设计立场（部署者决定，2026-08-31）：session id 是 resume 的唯一钥匙，「成功必有 id」。
// 双源提取（JSONL 主源 + banner 副源）都失败时，调用按失败上报，绝不静默返回无 id 的成功。

/** 严格 UUID（v4 格式不限大小写；codex 的 thread_id / session id 都是 UUID 形态）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 是否为合法 UUID 形态（工具入参与解析结果统一走这一道校验，防注入）。 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * 从 stdout JSONL 逐行提取 { sessionId, answer }。
 * 逐行解析：单行损坏/截断只报废该行，不影响首事件的 thread_id（抗尾部截断）。
 * @param {string} stdout  进程 stdout 全文（JSONL 或任意文本）
 * @returns {{ sessionId?: string, answer?: string }}
 */
export function parseJsonlOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return {}
  let sessionId
  let answer
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue // 非 JSON 行（混流防御）直接跳过
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'thread.started' && isUuid(event.thread_id) && sessionId === undefined) {
      sessionId = event.thread_id
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message'
      && typeof event.item?.text === 'string' && event.item.text.length > 0) {
      answer = event.item.text // 取最后一条非空 agent_message
    }
  }
  return { sessionId, answer }
}

/** 从任意文本（stdout 原文或 stderr）提取 banner 的 session id 行。 */
export function parseBannerSessionId(text) {
  if (typeof text !== 'string') return undefined
  const m = /^\s*session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im.exec(text)
  return m ? m[1] : undefined
}

/**
 * 双源汇总：JSONL 主源优先，banner 副源兜底。
 * @param {{ stdout: string, stderr: string }} streams
 * @returns {{ sessionId?: string, answer?: string, jsonlParsed: boolean }}
 */
export function extractCodexOutput({ stdout, stderr }) {
  const jsonl = parseJsonlOutput(stdout)
  const sessionId = jsonl.sessionId ?? parseBannerSessionId(stdout) ?? parseBannerSessionId(stderr)
  return {
    sessionId,
    answer: jsonl.answer,
    jsonlParsed: jsonl.sessionId !== undefined || jsonl.answer !== undefined,
  }
}

/**
 * 「成功必有 id」判定：completed 但拿不到合法 session id → 失败（fail loud）。
 * @param {{ sessionId?: string }} parsed
 * @returns {string | undefined} 失败原因；undefined = id 在手
 */
export function missingSessionIdReason(parsed) {
  return isUuid(parsed.sessionId) ? undefined
    : 'codex session id was not captured from --json events or the session id banner; ' +
      'refusing to return a session-less success (resume continuity would break). ' +
      'If the codex CLI version changed its output format, re-verify parseJsonlOutput/parseBannerSessionId against it.'
}

/** 供 job_output 后台分支回读的文本尾巴（runOutcome 只保留 output 文本，见 run-settlement.js）。 */
export function sessionFooter(sessionId) {
  return isUuid(sessionId) ? '\n\nsession id: ' + sessionId : ''
}
