// dsh-external-agents provider.mjs
// 出进程外部 CLI Agent 的 dsh-subagent provider（one-shot）。
// 复用 @deepseek-ai/dsh-subagent 的出进程工具函数（NO_START_CAPABILITIES / resolveChildCwd /
// settleRunResult / subprocessRunHandle），进程机制走 ctx.subprocess 缝隙。

import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'

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
 * @param {number} opts.graceMs              终止升级 SIGTERM→SIGKILL 的宽限
 * @param {number} opts.maxOutputBytes       stdout/stderr 内存缓冲上限
 */
export function createCliProvider({ ctx, name, config, graceMs, maxOutputBytes }) {
  const prefix = 'external-agents:' + name
  return {
    name,
    // 出进程后端兑现不了父侧强制的 start 特性（outputSchema/maxDepth/toolFilter/persona），一律 false。
    capabilities: NO_START_CAPABILITIES,
    // 外部进程看不到父会话历史。
    inheritsParentContext: false,
    async start(request) {
      const command = String(config.command ?? '').trim()
      if (!command) throw new Error(prefix + ': command is required')

      // 1) 解析可执行文件（绝对路径校验 / 裸名走 scrubbed PATH），失败在 spawn 前就报清楚。
      const program = await ctx.subprocess.resolveExecutable(command, config.env, request.signal)

      // 2) 子进程 cwd：配置覆盖 → 父会话工作目录。
      const cwd = resolveChildCwd(prefix, config.cwd ?? undefined, parentCwdOf(request.parent))

      // 3) argv：base args → extraArgs（自定义 provider 的 -c 覆盖等）→（可选）模型切换 flag →（可选）stdin 哨兵。
      const args = Array.isArray(config.args) ? config.args.map(String) : []
      const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : []
      const model = (typeof config.model === 'string' && config.model.trim()) ? config.model.trim() : undefined
      const argv = [
        program,
        ...args,
        ...extraArgs,
        ...(model && config.modelFlag ? [config.modelFlag, model] : []),
        ...(config.stdinSentinel ? [config.stdinSentinel] : []),
      ]

      const promptText = contentToText(request.prompt)

      // 4) spawn：stdin 批式写 prompt 并关闭（{ data } 形态）；stdout/stderr 走 collect（有界 + 读后仍在）。
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: { data: promptText },
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs,
        signal: request.signal, // abort → 树级终止升级
        env: config.env,
      })

      // 出进程 run 自铸唯一 id（remote provider 在父命名空间内唯一即可）。
      const id = 'ext-' + name + '-' + process.pid + '-' + Date.now().toString(36) + '-' + (++seq).toString(36)

      // 结果文本：优先 stdout，退回 stderr（出错的最后回应常在 stderr）。
      const collectOutput = () => {
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        const text = (out || err || '').trim()
        return text ? [{ type: 'text', text }] : []
      }

      const attempt = async () => {
        const outcome = await handle.done
        const output = collectOutput()
        return { output, stopReason: outcome.exitCode === 0 ? 'completed' : 'error' }
      }

      const onAbort = () => { handle.terminate() }
      request.signal.addEventListener('abort', onAbort)

      // never-reject 沉降：取消→aborted、异常→error（settle 时移除 abort 监听）。
      const result = settleRunResult({
        attempt,
        collectOutput,
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