// dsh-external-agents tool.mjs 单测：用 mock ctx 验证 codex 单工具的
// 注册（description 动态列举）、同步/异步分支、后台取消链、codex_models 查询与 claude 单工具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountCodexTools, mountSingleTool } from '../src/tool.mjs'
import { parseCodexConfig, parseClaudeConfig } from '../src/route.mjs'

function codexSpec() {
  return parseCodexConfig({
    command: 'codex',
    args: ['exec', '-s', 'workspace-write'],
    defaultModel: 'flash',
    providers: { builtin: { type: 'builtin' } },
    models: {
      flash: { provider: 'builtin', model: 'flash' },
      pro: { provider: 'builtin', model: 'pro' },
    },
  })
}

/** 造一个最小 cordis ctx mock：tools.register 捕获 def；subagents.start + jobs 可观测。 */
function makeCtx() {
  const defs = {}
  const starts = []
  const jobs = []
  const signalSeen = []
  const ctx = {
    defs, starts, jobs, signalSeen,
    get: (name) => (name === 'jobs' ? {
      start(spec) {
        jobs.push(spec)
        return 'subagent-' + jobs.length
      },
    } : undefined),
    subagents: {
      async start(name, req) {
        starts.push(name)
        signalSeen.push(req.signal)
        return {
          id: 'r' + starts.length,
          get result() {
            return Promise.resolve({
              output: [{ type: 'text', text: 'child-out' }],
              stopReason: (req.signal && req.signal.aborted) ? 'aborted' : 'completed',
            })
          },
          async dispose() {},
        }
      },
      registerProvider() { return () => {} },
    },
    tools: {
      register(def) { defs[def.name] = def; return () => { delete defs[def.name] } },
      get(name) { return defs[name] },
    },
    effect(fn) { return fn() },
    on() {},
    logger: { info() {}, warn() {}, error() {} },
  }
  return ctx
}

const agent = { session: { header: { cwd: '/ws' } } }
function execSignal() { return { agent, signal: new AbortController().signal } }

test('codex 单工具注册：model 参数 + description 动态列举 + codex_models', () => {
  const ctx = makeCtx()
  const dispose = mountCodexTools(ctx, codexSpec())
  const tool = ctx.defs.codex
  assert.ok(tool, 'codex tool registered')
  const props = tool.parameters.properties
  assert.ok(props.model, 'model param present')
  assert.ok(props.prompt, 'prompt param present')
  assert.match(tool.description, /可用 model：flash \/ pro（默认 flash）/)
  assert.equal(tool.isConcurrencySafe({ description: 'd', prompt: 'p' }), true)
  const modelsTool = ctx.defs.codex_models
  assert.ok(modelsTool, 'codex_models tool registered')
  assert.equal(modelsTool.isConcurrencySafe({}), true)
  dispose()
  assert.equal(ctx.defs.codex, undefined, 'dispose removes tool')
})

test('codex 前台同步：路由到正确 provider 并返回 foreground result', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  const out = await ctx.defs.codex.execute({ description: 't', prompt: 'p', model: 'pro' }, execSignal())
  assert.equal(out.kind, 'foreground')
  assert.equal(out.runId, 'r1')
  assert.deepEqual(ctx.starts, ['external:codex:pro'])
  assert.deepEqual(out.output, [{ type: 'text', text: 'child-out' }])
})

test('codex 省 model 参数时用默认别名', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  await ctx.defs.codex.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.deepEqual(ctx.starts, ['external:codex:flash'])
})

test('codex 未知 model：throw（不进 subagent）', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  await assert.rejects(
    () => ctx.defs.codex.execute({ description: 't', prompt: 'p', model: 'nope' }, execSignal()),
    /unknown model "nope".*available: flash, pro/,
  )
  assert.deepEqual(ctx.starts, [])
})

test('codex 后台异步：立即返回 jobId，jobs.start 收到 owner+run', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  const out = await ctx.defs.codex.execute({ description: 'bg', prompt: 'p', model: 'flash', run_in_background: true }, execSignal())
  assert.equal(out.kind, 'background')
  assert.equal(out.jobId, 'subagent-1')
  const job = ctx.jobs[0]
  assert.equal(job.kind, 'subagent')
  assert.equal(job.owner, agent)
  assert.equal(job.label, 'bg')
  assert.equal(typeof job.run, 'function')
})

test('后台取消链：cancel → AbortSignal → subagent start 后被标记 aborted', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  await ctx.defs.codex.execute({ description: 'bg', prompt: 'p', run_in_background: true }, execSignal())
  const job = ctx.jobs[0]
  const { cancel, done } = job.run()
  cancel('kill me')
  assert.ok(ctx.signalSeen[0].aborted, 'subagent 收到的 signal 已 abort')
  const outcome = await done
  assert.ok(['killed', 'failed', 'finished'].includes(outcome.status), 'done 稳定沉降为 JobOutcome')
})

test('claude 单工具：自写注册（无 model 参数时省略 model）', () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude', args: ['--print'] })
  const dispose = mountSingleTool(ctx, {
    toolName: cs.toolName,
    providerName: 'external:claude',
    body: 'claude body',
    modelInfo: cs.model ? { modelDescription: 'd' } : undefined,
  })
  const tool = ctx.defs.claude_code
  assert.ok(tool, 'claude single tool registered')
  const props = tool.parameters.properties
  assert.ok(!props.model, '无 model 时不暴露 model 参数')
  assert.ok(props.run_in_background, 'run_in_background 存在')
  dispose()
  assert.equal(ctx.defs.claude_code, undefined)
})

test('claude 单工具前台：路由到 external:claude（不暴露 model 参数，模型由 config 烘焙）', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude', args: ['--print'], model: 'provider-model' })
  mountSingleTool(ctx, {
    toolName: cs.toolName,
    providerName: 'external:claude',
    body: 'claude body',
    modelInfo: undefined,
  })
  const tool = ctx.defs.claude_code
  assert.ok(!tool.parameters.properties.model, 'claude 不暴露 model 参数，模型由 config.claude.model 决定')
  const out = await tool.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.equal(out.kind, 'foreground')
  assert.deepEqual(ctx.starts, ['external:claude'])
})
