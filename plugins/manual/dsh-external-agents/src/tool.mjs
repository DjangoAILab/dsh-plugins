// dsh-external-agents tool.mjs
// 自写模型面工具（替代第三方 dsh-tool-subagent，见 DESIGN.md §4）：
//   - codex       单工具 + model 参数，内部按别名路由到 route provider；副带 codex_models 查询工具。
//   - claude_code 单 provider 工具（可带可选 model 参数走 --model）。
// 同步分支 = await ctx.subagents.start(...).result → dispose；异步分支 = ctx.jobs.start（原生后台 Job，
// 模型用官方 job_output 轮询 / job_kill 取消），收尾复用 settleRun，不自造生命周期。
// 工具只收「模型别名/参数」，不收 baseUrl/key/provider/argv（防注入）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'

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
    return { kind: 'foreground', runId: run.id, output: result.output }
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

/** 规范化的输出 schema（前台 result / 后台 jobId 两态）。 */
const DELEGATION_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'background' },
        jobId: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'foreground' },
        runId: { type: 'string', required: true },
        output: { type: 'array', required: true, items: { type: 'json' } },
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
  return ctx.tools.register(defineTool({
    name: o.toolName,
    description: o.body,
    parameters: {
      description: {
        type: 'string', required: true,
        description: '任务的简短（3-5 词）说明，仅用于展示与 Job 标签。',
      },
      ...(o.modelInfo ? { model: { type: 'string', description: o.modelInfo.modelDescription } } : {}),
      prompt: {
        type: 'string', required: true,
        description: '交给外部 agent 的自包含任务。它看不到本会话上下文，请把全部所需信息写进来。',
      },
      run_in_background: {
        type: 'boolean',
        description: '是否作为后台 Job 运行并立即返回 jobId（默认 false）。true 后用 job_output 轮询、job_kill 取消。',
      },
    },
    output: {
      schema: DELEGATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background' ? 'started background ' + o.toolName + ' job ' + value.jobId : outputValueText(value.output),
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
      '。同步调用阻塞等 CLI 结束；设置 run_in_background: true 则立刻返回后台 Job id，之后用 job_output 轮询、job_kill 取消。',
    parameters: {
      description: {
        type: 'string', required: true,
        description: '任务的简短（3-5 词）说明，仅用于展示与 Job 标签。',
      },
      model: {
        type: 'string',
        description: '要用的 model 别名。' + listWording + '。省略用默认。',
      },
      prompt: {
        type: 'string', required: true,
        description: '交给外部 agent 的自包含任务。它看不到本会话上下文，请把全部所需信息写进来。',
      },
      run_in_background: {
        type: 'boolean',
        description: '是否作为后台 Job 运行并立即返回 jobId（默认 false）。true 后用 job_output 轮询、job_kill 取消。',
      },
    },
    output: {
      schema: DELEGATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background' ? 'started background codex job ' + value.jobId : outputValueText(value.output),
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
      const request = { label: args.description, prompt: [{ type: 'text', text: args.prompt }], parent }
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