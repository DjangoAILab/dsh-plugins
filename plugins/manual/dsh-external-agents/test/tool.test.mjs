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
  assert.match(tool.description, /不要 sleep\/轮询/)
  assert.match(tool.parameters.properties.run_in_background.description, /wait: true/)
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

test('后台收数引导：render 带 jobId 的后台结果必须携带 wait/通知最佳实践文案', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  const codexBg = await ctx.defs.codex.execute({ description: 'bg', prompt: 'p', run_in_background: true }, execSignal())
  const codexRender = ctx.defs.codex.output.render({}, codexBg)[0].text
  assert.match(codexRender, /subagent-1/)
  assert.match(codexRender, /wait: true/)
  assert.match(codexRender, /不要 sleep 或定时轮询/)
  assert.match(codexRender, /完成时父会话会自动收到 completion notice/)

  const cs = parseClaudeConfig({ command: 'claude', args: ['--print'] })
  mountSingleTool(ctx, { toolName: cs.toolName, providerName: 'external:claude', body: 'b', modelInfo: undefined })
  const claudeBg = await ctx.defs.claude_code.execute({ description: 'bg', prompt: 'p', run_in_background: true }, execSignal())
  const claudeRender = ctx.defs.claude_code.output.render({}, claudeBg)[0].text
  assert.match(claudeRender, /subagent-2/)
  assert.match(claudeRender, /job_kill/)
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
  assert.match(props.run_in_background.description, /wait: true/, '参数文案必须引导 wait:true/完成通知，不能只说轮询')
  dispose()
  assert.equal(ctx.defs.claude_code, undefined)
})

test('claude 单工具前台：路由到 external:claude（不暴露 model 参数，模型由 config 烘焙）', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude', args: ['--print'], model: 'provider-model-fast' })
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
// ---- v2.4 session 连续性：session_id 参数 ----

test('v2.4：session_id 缺省 → request 不带 sessionId（全新会话路径）', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  const seen = []
  ctx.subagents.start = async (name, req) => { seen.push(req); return { id: 'rx', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }), dispose: async () => {} } }
  await ctx.defs.codex.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.equal(seen[0].sessionId, undefined)
})

test('v2.4：合法 UUID session_id → provider 收到（mock start 捕获 request）', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  // mock start 把 request 记下来（makeCtx 的 starts 只记 provider 名，这里补一处 request 捕获）
  const seen = []
  ctx.subagents.start = async (name, req) => { seen.push(req); return { id: 'rx', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }), dispose: async () => {} } }
  const sid = '01a056eb-14ab-7b63-a3c8-ef286678ecb0'
  const out = await ctx.defs.codex.execute({ description: 't', prompt: 'p', session_id: sid }, execSignal())
  assert.equal(seen[0].sessionId, sid)
  assert.equal(out.sessionId, undefined) // mock result 无 sessionId 字段，schema 可选容错
})

test('v2.4 fail loud：非法 session_id（防注入，拒绝在触达 provider 之前）', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  await assert.rejects(
    () => ctx.defs.codex.execute({ description: 't', prompt: 'p', session_id: 'x; rm -rf /' }, execSignal()),
    /session_id must be a UUID/,
  )
  assert.deepEqual(ctx.starts, [])
})

test('v2.4：前台结果携带 sessionId + render 末尾 session id 尾行', async () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  const sid = '01a056eb-14ab-7b63-a3c8-ef286678ecb0'
  ctx.subagents.start = async (name, req) => ({ id: 'rx', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed', sessionId: sid }), dispose: async () => {} })
  const out = await ctx.defs.codex.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.equal(out.sessionId, sid)
  const rendered = ctx.defs.codex.output.render({}, out)[0].text
  assert.match(rendered, /session id: 01a056eb-14ab-7b63-a3c8-ef286678ecb0$/)
})

test('v2.4：工具 description 教父模型回传 session id', () => {
  const ctx = makeCtx()
  mountCodexTools(ctx, codexSpec())
  assert.match(ctx.defs.codex.description, /session_id/)
  assert.match(ctx.defs.codex.description, /session id 行是续接凭证/)
})

// ---- v2.5 claude session 连续性 ----

test('v2.5 claude：sessionSupport 开启时新会话预生成 UUID + freshSession 标记', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude' })
  mountSingleTool(ctx, { toolName: cs.toolName, providerName: 'external:claude', body: 'b', modelInfo: undefined, sessionSupport: cs.sessionSupport })
  const tool = ctx.defs.claude_code
  assert.ok(tool.parameters.properties.session_id, 'session_id param present')
  const seen = []
  ctx.subagents.start = async (name, req) => { seen.push(req); return { id: 'rc', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed', sessionId: req.sessionId }), dispose: async () => {} } }
  const out = await tool.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.match(seen[0].sessionId, /^[0-9a-f-]{36}$/)
  assert.equal(seen[0].freshSession, true)
  assert.equal(out.sessionId, seen[0].sessionId)
  const rendered = tool.output.render({}, out)[0].text
  assert.match(rendered, new RegExp('session id: ' + out.sessionId + '$'))
})

test('v2.5 claude：session_id 传回 → freshSession=false（resume 路径）', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude' })
  mountSingleTool(ctx, { toolName: cs.toolName, providerName: 'external:claude', body: 'b', modelInfo: undefined, sessionSupport: true })
  const seen = []
  ctx.subagents.start = async (name, req) => { seen.push(req); return { id: 'rc', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed', sessionId: req.sessionId }), dispose: async () => {} } }
  const sid = '01a05ac8-f34b-7d93-b5cc-ef59bf344983'
  await ctx.defs.claude_code.execute({ description: 't', prompt: 'p', session_id: sid }, execSignal())
  assert.equal(seen[0].sessionId, sid)
  assert.equal(seen[0].freshSession, false)
})

test('v2.5 claude fail loud：非法 session_id', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude' })
  mountSingleTool(ctx, { toolName: cs.toolName, providerName: 'external:claude', body: 'b', modelInfo: undefined, sessionSupport: true })
  await assert.rejects(
    () => ctx.defs.claude_code.execute({ description: 't', prompt: 'p', session_id: 'bad; rm -rf' }, execSignal()),
    /session_id must be a UUID/,
  )
})

test('v2.5 claude：sessionSupport 关闭时无 session_id 参数且不注入', async () => {
  const ctx = makeCtx()
  const cs = parseClaudeConfig({ command: 'claude', session: false })
  mountSingleTool(ctx, { toolName: cs.toolName, providerName: 'external:claude', body: 'b', modelInfo: undefined, sessionSupport: cs.sessionSupport })
  assert.equal(ctx.defs.claude_code.parameters.properties.session_id, undefined)
  const seen = []
  ctx.subagents.start = async (name, req) => { seen.push(req); return { id: 'rc', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }), dispose: async () => {} } }
  await ctx.defs.claude_code.execute({ description: 't', prompt: 'p' }, execSignal())
  assert.equal(seen[0].sessionId, undefined)
})
