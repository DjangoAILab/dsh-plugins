// dsh-external-agents tool.mjs
// 自写模型面工具（替代第三方 dsh-tool-subagent，见 DESIGN.md §4）：
//   - codex       单工具 + model 参数，内部按别名路由到 route provider；副带 codex_models 查询工具。
//   - claude_code 单 provider 工具（可带可选 model 参数走 --model）。
// 同步分支 = await ctx.subagents.start(...).result → dispose；异步分支 = ctx.jobs.start（原生后台 Job，
// 收数 = 完成自动 notice / job_output(wait:true) 带上限阻塞等待，job_kill 取消），收尾复用 settleRun。
// 工具只收「模型别名/参数」，不收 baseUrl/key/provider/argv（防注入）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { isUuid, sessionFooter } from './codex-output.mjs'
import { randomUUID } from 'node:crypto'

/** 从 canonical JSON block 数组抽取纯文本，绝不信任任意值。 */
function outputValueText(values) {
  return values
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

/** 一个非 completed 的 stopReason 意味着子进程没有干净跑完。 */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

/** 把保留下来的部分输出接到 stop-reason 错误后，让被截断/取消子进程的真实文本仍能回到父模型。 */
function withPartialText(error, output) {
  const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('')
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text
}

/** 收集并释放一次前台 run，且不让 dispose 的失败覆盖独立的结果失败。 */
async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result)
    if (error !== void 0) throw new Error(withPartialText(error, result.output))
    // v2.5：sessionId 非字符串（如 claude 路径未捕获）时不设键——宿主对 canonical value 做 lossless JSON 检查，
    // 带 undefined 值的键会被拒（实测 "value is not lossless JSON"）。
    return typeof result.sessionId === 'string'
      ? { kind: 'foreground', runId: run.id, output: result.output, sessionId: result.sessionId }
      : { kind: 'foreground', runId: run.id, output: result.output }
  })])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], 'subagent run failed: ' + String(execution.reason) + '; dispose failed: ' + String(disposal.reason))
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** 异步分支：settle 一次 start，且不让其 reject 破坏后台任务 producer 契约。 */
async function settleStart(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/**
 * 后台 Job 收数最佳实践（模型可见文案，单一权威定义；DESIGN.md §8 有机制证据）。
 * 依据 dsh-tool-jobs：完成时 onJobDone 自动向父会话投递 notice（idle 父会话 wakeup 唤醒）；
 * job_output(wait:true, timeout_ms) 完成即提前返回、到时返回 [status: running] 且 job 存活。
 * 措辞刻意点名「不要 sleep、不要定时轮询」，防止父模型交出任务后空转占上下文。
 */
export const BACKEND_JOB_GUIDANCE =
  '后台 Job 完成时父会话会自动收到 completion notice（无需轮询）：拿到 jobId 后优先继续做与该任务无关的独立工作，等通知到达再 job_output 读结果。'
  + '确实没有独立工作、下一步又依赖结果时，才用 job_output(job_id, wait: true, timeout_ms: N) 阻塞等待——完成即提前返回，到时返回 [status: running]（job 继续存活，可再次等待）。'
  + '不要 sleep 或定时轮询；废弃不用的 job 用 job_kill 回收。'

/**
 * session 连续性指引（v2.4）：结果末尾带 session id 行，父 agent 把它原样传回下一轮的
 * session_id 参数即可续接同一 codex 会话（多轮迭代免重发全部上文）。并发多个 codex run
 * 时必须各用各的 id（插件无 --last 隐式续接）；同 session 的续接由父 agent 串行化。
 */
export const SESSION_CONTINUITY_GUIDANCE =
  '结果末尾的 session id 行是续接凭证：需要在该 codex 会话上继续追问/迭代时，把它原样传回 session_id 参数再发新 prompt；'
  + '一次性任务无需理会。并发多个 codex 会话时各用各的 id，不要混用。'

/** 规范化的输出 schema（前台 result / 后台 jobId 两态）。 */
const DELEGATION_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'background' },
        jobId: { type: 'string', required: true },
        sessionId: { type: 'string' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'foreground' },
        runId: { type: 'string', required: true },
        output: { type: 'array', required: true, items: { type: 'json' } },
        sessionId: { type: 'string' },
      },
    },
  ],
}

/**
 * 让一个子 agent provider 以模型可见工具暴露。单 provider 版本（无别名路由）。
 * @param {object} o
 * @param {object} o.ctx    cordis 上下文
 * @param {string} o.toolName      模型可见工具名
 * @param {string} o.providerName  已注册的 subagent provider 名
 * @param {string} o.body          工具 description 的主干
 * @param {{model?:string, modelDescription?:string}} [o.modelInfo] 可选 model 参数（claude 走 --model）
 * @returns {() => void} disposer（归入当前 fiber）
 */
export function mountSingleTool(ctx, o) {
  const ss = o.sessionSupport === true
  return ctx.tools.register(defineTool({
    name: o.toolName,
    description: o.body,
    parameters: {
      description: {
        type: 'string', required: true,
        description: '任务的简短（3-5 词）说明，仅用于展示与 Job 标签。',
      },
      ...(o.modelInfo ? { model: { type: 'string', description: o.modelInfo.modelDescription } } : {}),
      ...(ss ? {
        session_id: {
          type: 'string',
          description: '可选：要续接的 claude 会话 UUID（取自上一次结果末尾的 session id 行）。省略 = 全新会话。给了它，本次 prompt 作为该会话的下一轮，继承其全部上下文。',
        },
      } : {}),
      prompt: {
        type: 'string', required: true,
        description: '交给外部 agent 的自包含任务。它看不到本会话上下文，请把全部所需信息写进来。',
      },
      run_in_background: {
        type: 'boolean',
        description: '是否作为后台 Job 运行并立即返回 jobId（默认 false）。收数：等完成通知（自动唤醒）再 job_output 读，或 job_output(wait: true, timeout_ms) 阻塞等待；job_kill 取消。不要 sleep/轮询。',
      },
    },
    output: {
      schema: DELEGATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? 'started background ' + o.toolName + ' job ' + value.jobId + '。' + BACKEND_JOB_GUIDANCE
            + (ss && typeof value.sessionId === 'string' ? '\n本 job 的 claude 会话 id（完成后可续接）: ' + value.sessionId : '')
          : outputValueText(value.output) + (ss && !outputValueText(value.output).includes('\nsession id: ') ? sessionFooter(value.sessionId) : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(o.toolName + ' tool requires a calling agent (exec.agent was undefined)')
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
      }
      if (ss) {
        // v2.5 claude session：resume 用父传回的 id；新会话在工具层预生成 UUID 透传给 provider
        //（--session-id <uuid>），父 agent 从本工具返回值（schema sessionId / render 尾行）拿到它。
        if (args.session_id !== undefined && !isUuid(args.session_id)) {
          throw new Error(o.toolName + ': session_id must be a UUID (copy it verbatim from the previous result\'s "session id:" line)')
        }
        request.sessionId = args.session_id ?? randomUUID()
        request.freshSession = args.session_id === undefined
      }
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === void 0) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              return {
                cancel: (reason) => { controller.abort(reason ?? 'background subagent task killed') },
                done: settleStart(ctx.subagents.start(o.providerName, { ...request, signal: controller.signal }), controller.signal),
              }
            },
          }),
          // v2.5：claude 新会话的 id 在 spawn 前就定了，后台 ACK 直接告知父 agent（不用等 job 完成）。
          ...(ss ? { sessionId: request.sessionId } : {}),
        }
      }
      return settleForegroundRun(await ctx.subagents.start(o.providerName, { ...request, signal: exec.signal }))
    },
  }))
}

/**
 * 挂载 codex v2 的「单工具 + model 参数（别名路由）」+「codex_models 查询工具」。
 * @param {object} ctx   cordis 上下文
 * @param {object} spec  route.mjs parseCodexConfig 的规范化结果
 * @returns {() => void} disposer
 */
export function mountCodexTools(ctx, spec) {
  const toolName = spec.toolName
  const aliasMap = new Map(spec.models.map((m) => [m.alias, m.providerName]))
  const listWording = '可用 model：' + spec.modelAliases.join(' / ') + '（默认 ' + spec.defaultModel + '）'

  const disposeTool = ctx.tools.register(defineTool({
    name: toolName,
    description:
      '把一个自包含任务交给外部 agent（codex）在独立上下文里一次性跑完。' + listWording +
      '。同步调用阻塞等 CLI 结束；设置 run_in_background: true 则立刻返回后台 Job id（收数：完成自动通知，或 job_output(wait:true) 带上限等待；不要 sleep/轮询）。'
      + '结果末尾附带 session id 行；要在同一 codex 会话上继续迭代，把它原样传回 session_id 参数（省略 = 全新会话）。' + SESSION_CONTINUITY_GUIDANCE,
    parameters: {
      description: {
        type: 'string', required: true,
        description: '任务的简短（3-5 词）说明，仅用于展示与 Job 标签。',
      },
      model: {
        type: 'string',
        description: '要用的 model 别名。' + listWording + '。省略用默认。',
      },
      session_id: {
        type: 'string',
        description: '可选：要续接的 codex 会话 UUID（取自上一次 codex 结果末尾的 session id 行）。省略 = 全新会话。给了它，本次 prompt 作为该会话的下一轮，继承其全部上下文。',
      },
      prompt: {
        type: 'string', required: true,
        description: '交给外部 agent 的自包含任务。它看不到本会话上下文，请把全部所需信息写进来。',
      },
      run_in_background: {
        type: 'boolean',
        description: '是否作为后台 Job 运行并立即返回 jobId（默认 false）。收数：等完成通知（自动唤醒）再 job_output 读，或 job_output(wait: true, timeout_ms) 阻塞等待；job_kill 取消。不要 sleep/轮询。',
      },
    },
    output: {
      schema: DELEGATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        // v2.4.1：provider 已把 session id 尾行嵌入输出文本（后台 Job 通知面也能看到），
        // 这里只在文本里还没有时才补（前台 schema sessionId 字段照旧携带）。
        text: value.kind === 'background'
          ? 'started background codex job ' + value.jobId + '。' + BACKEND_JOB_GUIDANCE
          : outputValueText(value.output) + (outputValueText(value.output).includes('\nsession id: ') ? '' : sessionFooter(value.sessionId)),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(toolName + ' tool requires a calling agent (exec.agent was undefined)')
      const alias = args.model ?? spec.defaultModel
      const providerName = aliasMap.get(alias)
      if (!providerName) {
        throw new Error('external-agents: unknown model "' + String(alias) + '"; available: ' + spec.modelAliases.join(', '))
      }
      // session_id 防注入：只收严格 UUID（provider 侧再校验一道，argv 只会拼上合法值）。
      if (args.session_id !== undefined && !isUuid(args.session_id)) {
        throw new Error(toolName + ': session_id must be a UUID (copy it verbatim from the previous result\'s "session id:" line)')
      }
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...(args.session_id !== undefined ? { sessionId: args.session_id } : {}),
      }
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === void 0) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              return {
                cancel: (reason) => { controller.abort(reason ?? 'background subagent task killed') },
                done: settleStart(ctx.subagents.start(providerName, { ...request, signal: controller.signal }), controller.signal),
              }
            },
          }),
        }
      }
      return settleForegroundRun(await ctx.subagents.start(providerName, { ...request, signal: exec.signal }))
    },
  }))

  const disposeModels = ctx.tools.register(defineTool({
    name: toolName + '_models',
    description: '查询 codex 当前可用的 model 别名 → provider → 实际模型的映射及默认模型。模型配置可能随发布变化，需要时用本工具刷新（模型少且稳定时，codex 工具 description 已足够）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          toolName: { type: 'string', required: true },
          defaultModel: { type: 'string', required: true },
          command: { type: 'string', required: true },
          models: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                kind: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.toolName + ' models (default ' + value.defaultModel + '):\n'
          + value.models.map((m) => '  - ' + m.alias + ' -> provider "' + m.provider + '" model "' + m.model + '" (' + m.kind + ')').join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { toolName: spec.toolName, defaultModel: spec.defaultModel, command: spec.command, models: spec.modelsView }
    },
  }))

  return () => { disposeTool(); disposeModels() }
}