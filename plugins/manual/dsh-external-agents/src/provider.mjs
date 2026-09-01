// dsh-external-agents provider.mjs
// 出进程外部 CLI Agent 的 dsh-subagent provider（one-shot）。
// 复用 @deepseek-ai/dsh-subagent 的出进程工具函数（NO_START_CAPABILITIES / resolveChildCwd /
// settleRunResult / subprocessRunHandle），进程机制走 ctx.subprocess 缝隙。
//
// v2.4（codex session 连续性，机制证据均为 codex-cli 0.146.0 / dsh-subprocess 0.1.1-rc.2 实测）：
//   - codex 路由 spawn 恒带 --json：stdout 为纯 JSONL（日志走 stderr）。首事件
//     thread.started.thread_id 即 session id；最终回答取最后一条 agent_message。
//   - stdout collect 开 spill（保头）：thread.started 是首行，即使输出超内存尾窗，
//     sessionId 仍可从 stdout 全文提取；内存尾窗保最终回答（尾部聚类，tail-keep 语义）。
//   - session 通道：请求侧 request.sessionId（ctx.subagents.start 是 spread 透传，
//     自定义字段原样到达 provider）；结果侧挂在 result.sessionId（settleRunResult 对
//     completed 原样返回 attempt() 对象，前台 run.result 直达工具层）。后台 Job 的
//     runOutcome 只保留 output 文本，因此工具层把 sessionId 拼进输出尾行（sessionFooter）。
//   - resume：argv 从零构建 exec resume [resumeArgs] [extraArgs] [-m model] <sid> -
//     （resume 无 -s 旗标，权限继承原会话；省略 model 则继承原会话模型，实测确认）。
//     不与 args/argsProfiles 叠加、不去重——resumeArgs 是唯一旋钮，无魔法过滤。

import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import { extractCodexOutput, isUuid, missingSessionIdReason, sessionFooter } from './codex-output.mjs'
import { randomUUID } from 'node:crypto'

let seq = 0

// 把模型的 ContentBlock[] 压成纯文本（外部 CLI 只吃文本）。
function contentToText(blocks) {
  let text = ''
  for (const block of blocks ?? []) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

// 父会话工作目录：Session.header.cwd 是「会话创建时的绝对工作目录」。
function parentCwdOf(parent) {
  return parent?.session?.header?.cwd
}

/**
 * 造一个外部 CLI Agent 的 one-shot provider。
 * @param {object} opts
 * @param {object} opts.ctx                 cordis 上下文（读 ctx.subprocess）
 * @param {string} opts.name                 provider 注册名（如 codex / claude）
 * @param {object} opts.config               { command, args, env, cwd, model, modelFlag, stdinSentinel, extraArgs }
 * @param {object} [opts.codex]              codex 专属（缺省 = 非 codex 路由，走通用文本路径）：
 *   { resumeArgs: string[], stdoutMaxBytes: number } —— resume argv 旋钮与 stdout 缓冲/spill 配置
 * @param {number} opts.graceMs              终止升级 SIGTERM→SIGKILL 的宽限
 * @param {number} opts.maxOutputBytes       stdout/stderr 内存缓冲上限（codex 路径 stderr 用；stdout 用 codex.stdoutMaxBytes）
 */
export function createCliProvider({ ctx, name, config, codex, claudeSession, graceMs, maxOutputBytes }) {
  const prefix = 'external-agents:' + name
  // codex 路由（JSONL + resume）与通用路由（claude 等，行为不变）的分叉点。
  const codexMode = codex !== undefined
  // v2.5 claude session 连续性：{ resumeArg: '--resume', newSessionArg: '--session-id' }。
  return {
    name,
    // 出进程后端兑现不了父侧强制的 start 特性（outputSchema/maxDepth/toolFilter/persona），一律 false。
    capabilities: NO_START_CAPABILITIES,
    // 外部进程看不到父会话历史（resume 由 CLI 侧 rollout 文件承载，非父历史注入）。
    inheritsParentContext: false,
    async start(request) {
      const command = String(config.command ?? '').trim()
      if (!command) throw new Error(prefix + ': command is required')

      // 1) 解析可执行文件（绝对路径校验 / 裸名走 scrubbed PATH），失败在 spawn 前就报清楚。
      const program = await ctx.subprocess.resolveExecutable(command, config.env, request.signal)

      // 2) 子进程 cwd：配置覆盖 → 父会话工作目录。
      const cwd = resolveChildCwd(prefix, config.cwd ?? undefined, parentCwdOf(request.parent))

      // 3) argv。resume（request.sessionId 在手）与全新会话两条构建路径。
      const sessionId = request.sessionId === undefined ? undefined : String(request.sessionId)
      if (codexMode && sessionId !== undefined && !isUuid(sessionId)) {
        throw new Error(prefix + ': session_id must be a UUID (got malformed value; refusing to pass to argv)')
      }
      const resume = codexMode && sessionId !== undefined
      // v2.5：claude 模式实际写进 argv 的 session id（fresh=新 UUID / resume=传入 id），attempt 用它回传。
      let usedSessionId = codexMode ? sessionId : undefined
      const model = (typeof config.model === 'string' && config.model.trim()) ? config.model.trim() : undefined
      const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : []
      let argv
      if (resume) {
        // resume 路径：exec resume [resumeArgs] [extraArgs] [-m model]? <sid> -
        // 不叠加 args/argsProfiles（resume 无 -s，权限继承原会话）；省略 model 则继承原会话模型。
        const resumeArgs = Array.isArray(codex.resumeArgs) ? codex.resumeArgs.map(String) : []
        argv = [
          program,
          'exec', 'resume',
          ...resumeArgs,
          ...extraArgs,
          ...(model && config.modelFlag ? [config.modelFlag, model] : []),
          sessionId,
          ...(config.stdinSentinel ? [config.stdinSentinel] : []),
        ]
      } else if (claudeSession !== undefined) {
        // v2.5 claude session 连续性：
        //   freshSession（工具层预生成新 UUID）→ --session-id <uuid>；
        //   带 sessionId（非 fresh）→ --resume <sid> 续接（claude 2.1.220 实测同一 id 可多次 resume）。
        //   复用已存在 id 走 --session-id 会报 already-in-use 且 exit=0，故新会话永远用新 UUID。
        //   ⚠️ 分支依据是 freshSession 标志，不是 id 相等性——resume 时传入的 id 与「新 id」必然相同，
        //   按 id 相等性判断会把 resume 误判成 new（0.5.0 首版实测踩坑：Session ID already in use）。
        const args = Array.isArray(config.args) ? config.args.map(String) : []
        const isResume = sessionId !== undefined && request.freshSession !== true
        usedSessionId = isResume ? sessionId : (sessionId ?? randomUUID())
        const sessionArg = isResume
          ? [claudeSession.resumeArg, usedSessionId]
          : [claudeSession.newSessionArg, usedSessionId]
        argv = [
          program,
          ...args,
          ...extraArgs,
          ...(model && config.modelFlag ? [config.modelFlag, model] : []),
          ...sessionArg,
          ...(config.stdinSentinel ? [config.stdinSentinel] : []),
        ]
      } else {
        // 全新会话：base args → extraArgs →（可选）模型切换 flag →（可选）stdin 哨兵。
        const args = Array.isArray(config.args) ? config.args.map(String) : []
        argv = [
          program,
          ...args,
          ...extraArgs,
          ...(model && config.modelFlag ? [config.modelFlag, model] : []),
          ...(config.stdinSentinel ? [config.stdinSentinel] : []),
        ]
      }

      const promptText = contentToText(request.prompt)

      // 4) spawn：stdin 批式写 prompt 并关闭；stdout/stderr 走 collect（有界 + 读后仍在）。
      //    codex 路径 stdout：内存尾窗 256KB + spill 保头（thread.started 首行永在手）。
      const stdoutCollect = codexMode
        ? { maxBytes: codex.stdoutMaxBytes, spill: { maxBytes: codex.stdoutMaxBytes * 8 } }
        : { maxBytes: maxOutputBytes }
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: { data: promptText },
          stdout: stdoutCollect,
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs,
        signal: request.signal, // abort → 树级终止升级
        env: config.env,
      })

      // 出进程 run 自铸唯一 id（remote provider 在父命名空间内唯一即可）。
      const id = 'ext-' + name + '-' + process.pid + '-' + Date.now().toString(36) + '-' + (++seq).toString(36)

      // 结果文本与 session id：JSONL 主源（stdout 事件流）+ banner 副源（stdout/stderr 兜底）。
      const collectOutput = () => {
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : undefined
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : undefined
        const outText = out?.text ?? ''
        const errText = err?.text ?? ''
        if (!codexMode) {
          const text = (outText || errText || '').trim()
          return { blocks: text ? [{ type: 'text', text }] : [], sessionId: undefined }
        }
        const parsed = extractCodexOutput({ stdout: outText, stderr: errText })
        const text = (parsed.answer ?? (parsed.jsonlParsed ? '' : (outText || errText)) ?? '').trim()
        return {
          blocks: text ? [{ type: 'text', text }] : [],
          sessionId: parsed.sessionId,
          rawTail: (outText || errText).slice(-4000),
        }
      }

      const attempt = async () => {
        const outcome = await handle.done
        const { blocks, sessionId: captured, rawTail } = collectOutput()
        // v2.5 claude 模式：id 是插件自己选定/透传的（spawn 前已知），不依赖输出解析。
        const embedId = codexMode ? captured : usedSessionId
        if (isUuid(embedId) && blocks.length > 0) {
          const last = blocks[blocks.length - 1]
          if (last.type === 'text' && !last.text.includes('\nsession id: ')) {
            blocks[blocks.length - 1] = { type: 'text', text: last.text + sessionFooter(embedId) }
          }
        }
        if (outcome.exitCode !== 0) {
          return { output: blocks, stopReason: 'error', sessionId: embedId, ...(rawTail ? { diagnostic: rawTail } : {}) }
        }
        if (codexMode) {
          // 「成功必有 id」：completed 而拿不到合法 session id → 按失败上报，绝不静默降级。
          const missing = missingSessionIdReason({ sessionId: captured })
          if (missing !== undefined) {
            return { output: blocks, stopReason: 'error', sessionId: undefined, diagnostic: missing + (rawTail ? '\nstdout/stderr tail:\n' + rawTail : '') }
          }
        }
        return { output: blocks, stopReason: 'completed', sessionId: embedId }
      }

      const onAbort = () => { handle.terminate() }
      request.signal.addEventListener('abort', onAbort)

      // never-reject 沉降：取消→aborted、异常→error（settle 时移除 abort 监听）。
      const result = settleRunResult({
        attempt,
        collectOutput: () => collectOutput().blocks,
        cancelled: () => request.signal.aborted,
        signal: request.signal,
        onAbort,
        onError: (error, stopReason) => {
          try { ctx.logger?.warn?.('[' + prefix + ']', 'child settled as ' + stopReason + ':', error?.message) } catch { /* 日志失败绝不致命 */ }
        },
      })

      // 标准 out-of-process run 句柄（localAgent = undefined；dispose 幂等并做树级 teardown）。
      return subprocessRunHandle({
        id,
        result,
        signal: request.signal,
        onAbort,
        requestCancel: () => { handle.terminate() },
        teardown: async () => {
          handle.terminate()
          await handle.waitForExit()
        },
      })
    },
  }
}
