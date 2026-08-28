// dsh-external-agents route.mjs 单测（纯函数，无 ctx）
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexConfig, parseClaudeConfig, resolveSecret, resolveProviderInvocation, resolveArgsProfiles } from '../src/route.mjs'

const BUILTIN_PROVIDERS = { builtin: { type: 'builtin' } }

test('codex builtin 多 route 解析', () => {
  const spec = parseCodexConfig({
    command: 'codex',
    args: ['exec', '-s', 'workspace-write'],
    defaultModel: 'builtin-a',
    providers: BUILTIN_PROVIDERS,
    models: {
      'builtin-a': { provider: 'builtin', model: 'provider-model-a' },
      'builtin-b': { provider: 'builtin', model: 'provider-model-b' },
    },
  })
  assert.equal(spec.toolName, 'codex')
  assert.equal(spec.defaultModel, 'builtin-a')
  assert.equal(spec.models.length, 2)
  assert.equal(spec.models[0].providerName, 'external:codex:builtin-a')
  assert.equal(spec.models[0].kind, 'builtin')
  assert.deepEqual(spec.models[0].extraArgs, [])
  assert.deepEqual(spec.modelAliases, ['builtin-a', 'builtin-b'])
  assert.equal(spec.modelsView.length, 2)
  // description 动态列举依赖的就是 modelAliases，这里保证顺序稳定
  assert.equal(spec.modelAliases.join(' / '), 'builtin-a / builtin-b')
})

test('codex gateway(custom) route：-c 覆盖（含 name）+ env key', () => {
  const spec = parseCodexConfig({
    command: 'codex',
    defaultModel: 'fast',
    providers: {
      gateway: { baseUrl: 'https://api.example.com/v1', wireApi: 'responses', envKey: 'K', apiKey: 'test-key' },
    },
    models: { fast: { provider: 'gateway', model: 'provider-model-fast' } },
  })
  const r = spec.models[0]
  assert.equal(r.kind, 'custom')
  assert.equal(r.env.K, 'test-key')
  // name 覆盖是 codex 0.146 的硬性要求（缺它报 provider name must not be empty）
  assert.ok(r.extraArgs.includes('model_providers.gateway.name=gateway'))
  assert.ok(r.extraArgs.some((a) => a.startsWith('model_providers.gateway.base_url=')))
  assert.ok(r.extraArgs.includes('model_provider=gateway'))
})

test('codex route 缺 model 时回退到 alias 本身', () => {
  const spec = parseCodexConfig({
    command: 'codex', defaultModel: 'flash',
    providers: { builtin: { type: 'builtin' } },
    models: { flash: { provider: 'builtin' } },
  })
  assert.equal(spec.models[0].model, 'flash')
})

test('fail loud：未知 provider', () => {
  assert.throws(
    () => parseCodexConfig({ command: 'codex', providers: BUILTIN_PROVIDERS, models: { a: { provider: 'nope', model: 'x' } } }),
    /unknown provider "nope"/,
  )
})

test('fail loud：defaultModel 不在 models 中', () => {
  assert.throws(
    () => parseCodexConfig({ command: 'codex', defaultModel: 'zzz', providers: BUILTIN_PROVIDERS, models: { a: { provider: 'builtin', model: 'gpt' } } }),
    /defaultModel "zzz" is not a key/,
  )
})

test('fail loud：缺 command', () => {
  assert.throws(
    () => parseCodexConfig({ providers: BUILTIN_PROVIDERS, models: { a: { provider: 'builtin', model: 'gpt' } } }),
    /command is required/,
  )
})

test('fail loud：空 models', () => {
  assert.throws(
    () => parseCodexConfig({ command: 'codex', providers: BUILTIN_PROVIDERS, models: {} }),
    /at least one model alias/,
  )
})

test('fail loud：provider 的 models allowlist 不符', () => {
  assert.throws(
    () => parseCodexConfig({
      command: 'codex',
      providers: { p: { baseUrl: 'https://x/v1', wireApi: 'responses', envKey: 'K', apiKey: 'k', models: ['a', 'b'] } },
      models: { m: { provider: 'p', model: 'zzz' } },
    }),
    /allowlist \[a, b\] does not include model "zzz"/,
  )
})

test('fail loud：models 项不是对象', () => {
  assert.throws(
    () => parseCodexConfig({ command: 'codex', providers: BUILTIN_PROVIDERS, models: { a: 'builtin' } }),
    /must be an object \{ provider, model \}/,
  )
})

test('claude builtin 解析', () => {
  const s = parseClaudeConfig({ command: 'claude', args: ['--print'], model: 'provider-model' })
  assert.equal(s.toolName, 'claude_code')
  assert.equal(s.command, 'claude')
  assert.equal(s.model, 'provider-model')
  assert.equal(s.providerId, 'builtin')
  assert.equal(s.stdinSentinel, undefined)
})

test('claude custom provider → ANTHROPIC env', () => {
  process.env.TEST_ANTHROPIC_TOKEN = 'tok-abc'
  const s = parseClaudeConfig({
    command: 'claude',
    provider: 'cp',
    providers: { cp: { baseUrl: 'https://cb.example', apiKey: '${ENV:TEST_ANTHROPIC_TOKEN}' } },
  })
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://cb.example')
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'tok-abc')
})

test('claude fail loud：provider 未知', () => {
  assert.throws(() => parseClaudeConfig({ command: 'claude', provider: 'x', providers: {} }), /provider "x" not defined/)
})

test('resolveSecret：字面量透传 + ${ENV} 解析', () => {
  assert.equal(resolveSecret('plain'), 'plain')
  process.env.SECRET_V = 'v1'
  assert.equal(resolveSecret('${ENV:SECRET_V}'), 'v1')
  assert.throws(() => resolveSecret('${ENV:SECRET_NOT_SET_XYZ}'), /not set/)
})

test('resolveProviderInvocation：builtin 无 extraArgs / custom 有 -c', () => {
  const b = resolveProviderInvocation('builtin', { type: 'builtin' }, 'gpt')
  assert.equal(b.kind, 'builtin')
  assert.deepEqual(b.extraArgs, [])
  const c = resolveProviderInvocation('cp', { baseUrl: 'https://u/v1', wireApi: 'responses', envKey: 'CK', apiKey: 'k1' }, 'm1')
  assert.equal(c.kind, 'custom')
  assert.equal(c.env.CK, 'k1')
  assert.equal(c.model, 'm1')
})
// ---------- v2.2 权限档位（argsProfiles） ----------

test('resolveArgsProfiles：args 顶替 normal + 具名档位 + active 切换', () => {
  const r = resolveArgsProfiles({
    args: ['exec', '-s', 'workspace-write'],
    argsProfiles: { yolo: ['exec', '--dangerously-bypass-approvals-and-sandbox'], active: 'yolo' },
  }, 'codex')
  assert.equal(r.active, 'yolo')
  assert.deepEqual(r.args, ['exec', '--dangerously-bypass-approvals-and-sandbox'])
  assert.deepEqual(Object.keys(r.profiles).sort(), ['normal', 'yolo'])
  assert.deepEqual(r.profiles.normal, ['exec', '-s', 'workspace-write'])
})

test('resolveArgsProfiles：无 active 回落 normal（保守基线）', () => {
  const r = resolveArgsProfiles({
    args: ['--print'],
    argsProfiles: { restart: ['--print', '--allowedTools', 'Bash(echo:*)'] },
  }, 'claude')
  assert.equal(r.active, 'normal')
  assert.deepEqual(r.args, ['--print'])
})

test('resolveArgsProfiles：args 与 argsProfiles.normal 并存时 args 胜出', () => {
  const r = resolveArgsProfiles({
    args: ['from-args'],
    argsProfiles: { normal: ['from-profile'] },
  }, 'codex')
  assert.deepEqual(r.profiles.normal, ['from-args'])
})

test('codex spec 带出 argsProfiles 视图', () => {
  const spec = parseCodexConfig({
    command: 'codex',
    args: ['exec', '-s', 'workspace-write'],
    argsProfiles: { yolo: ['exec', '-s', 'danger-full-access'], active: 'normal' },
    providers: BUILTIN_PROVIDERS,
    models: { a: { provider: 'builtin', model: 'gpt' } },
  })
  assert.deepEqual(spec.argsProfiles, { active: 'normal', available: ['yolo', 'normal'] })
  assert.deepEqual(spec.args, ['exec', '-s', 'workspace-write'])
})

test('claude spec 带出 argsProfiles 视图', () => {
  const s = parseClaudeConfig({
    command: 'claude',
    args: ['--print'],
    argsProfiles: { batch: ['--print', '--allowedTools', 'Bash(echo:*)'] },
  })
  assert.deepEqual(s.argsProfiles, { active: 'normal', available: ['batch', 'normal'] })
})

test('fail loud：档位值不是数组', () => {
  assert.throws(
    () => resolveArgsProfiles({ args: ['a'], argsProfiles: { yolo: 'exec --yolo' } }, 'codex'),
    /argsProfiles\["yolo"\] must be an array/,
  )
})

test('legacy：args 与 argsProfiles 全缺省 = CLI 默认旗标（空 normal 档）', () => {
  const r = resolveArgsProfiles({}, 'claude')
  assert.equal(r.active, 'normal')
  assert.deepEqual(r.args, [])
  assert.deepEqual(r.profiles, { normal: [] })
  // active: normal 显式写但不给任何档位 → 同样合法回落
  const r2 = resolveArgsProfiles({ argsProfiles: { active: 'normal' } }, 'claude')
  assert.equal(r2.active, 'normal')
  assert.deepEqual(r2.args, [])
})

test('fail loud：缺 normal 基线（只有具名档）', () => {
  assert.throws(
    () => resolveArgsProfiles({ argsProfiles: { yolo: ['--yolo'] } }, 'claude'),
    /missing a "normal" baseline profile/,
  )
})

test('legacy：args 为空数组等同缺省（CLI 默认旗标）', () => {
  const r = resolveArgsProfiles({ args: [] }, 'codex')
  assert.equal(r.active, 'normal')
  assert.deepEqual(r.args, [])
  // 但有具名档位时，必须同时有 normal 基线（哪怕空数组）
  assert.throws(
    () => resolveArgsProfiles({ argsProfiles: { yolo: ['--yolo'] } }, 'codex'),
    /missing a "normal" baseline profile/,
  )
  const ok = resolveArgsProfiles({ argsProfiles: { yolo: ['--yolo'], normal: [] } }, 'codex')
  assert.deepEqual(ok.profiles.normal, [])
})

test('fail loud：active 指向未定义档位', () => {
  assert.throws(
    () => resolveArgsProfiles({ args: ['a'], argsProfiles: { active: 'turbo' } }, 'claude'),
    /active profile "turbo" is not defined/,
  )
})

test('parseClaudeConfig 透传 fail loud：具名档缺 normal 基线', () => {
  assert.throws(
    () => parseClaudeConfig({ command: 'claude', argsProfiles: { yolo: ['--print', '--dangerously-skip-permissions'] } }),
    /claude args profiles: missing a "normal" baseline/,
  )
})
