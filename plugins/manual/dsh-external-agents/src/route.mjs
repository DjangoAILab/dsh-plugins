// dsh-external-agents route.mjs
// v2 codex 配置解析：把「单工具 + model 参数」的配置面解析成一组 route。
// 一个 route = 一个模型别名 → 内部 subagent provider 名 + 该 provider 的规范化出进程 invocation。
// 本文件保持纯函数、无 ctx 依赖，便于单测。任何配置错误在此 fail loud（启动即报，绝不含糊）。
//
// v2 配置 schema（设计见 DESIGN.md §2）：
//   codex:
//     toolName: codex
//     command: codex
//     args: [...]
//     defaultModel: <别名>
//     providers:
//       builtin:  { type: builtin }                       # codex 内置 OpenAI（无需 baseUrl/key）
//       <id>:     { baseUrl, wireApi, envKey, apiKey, models? }   # 自定义 OpenAI-compatible 端点
//     models:                                             # 模型可见别名 -> route（provider + 实际 model）
//       <别名>: { provider: <providers 里的 id>, model: <实际模型名> }

/** 解析 ${ENV:NAME} 引用；否则原样返回。 */
export function resolveSecret(value) {
  if (typeof value !== 'string') return value
  const m = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim())
  if (m) {
    const v = process.env[m[1]]
    if (v === undefined) throw new Error('external-agents: env ref ' + m[1] + ' is not set')
    return v
  }
  return value
}

function fail(message) {
  throw new Error('external-agents: ' + message)
}

/**
 * 解析共享的「权限档位」（args profiles）。v2.2 新增；codex/claude 通用。
 *
 * 背景：headless CLI 没有交互审批面，因此权限必须由部署配置预先限定：
 *   headless 一次性运行没有人工审批面 —— codex exec 天生 approval: never（只剩沙箱边界），
 *   claude -p 遇需审批命令直接判 requires approval 拦截。放开只能靠 config 里的旗标档位；
 *   工具面不给模型暴露提权参数（防注入边界不变），切档 = 改配置 + 重装 + 重启 DSH。
 *
 * 配置形态（codex/claude 通用）：
 *   args: ['...']                    # normal 基线档（保守沙箱 / 无权限旗标）
 *   argsProfiles:                    # 具名档位 + 当下生效档
 *     normal: ['...']                #   可省（省略时由 args 顶替）
 *     yolo: ['...']                  #   全量信任档
 *     active: normal                 #   省略 = normal
 *
 * 兼容语义（v2.0/v2.1 配置原样可用）：
 *   - args 与 argsProfiles 都缺省 → normal = []（不追加任何旗标 = CLI 默认行为），active = normal。
 *   - args 与 argsProfiles.normal 并存时 args 胜出。
 *   - 一旦出现任何具名档位，就必须有 normal 基线（强制保守档与提权档共存、可回退）。
 * 失败一律 fail loud：档位值不是数组 / 缺 normal 基线 / active 指向未定义档位。
 *
 * @param {object} cfg        该 agent 的配置节
 * @param {string} agentLabel 报错前缀（'codex' / 'claude'）
 * @returns {{ active: string, profiles: Record<string, string[]>, args: string[] }}
 */
export function resolveArgsProfiles(cfg, agentLabel) {
  const bad = (message) => fail(agentLabel + ' args profiles: ' + message)

  const raw = (cfg.argsProfiles && typeof cfg.argsProfiles === 'object' && !Array.isArray(cfg.argsProfiles))
    ? cfg.argsProfiles
    : {}
  const profiles = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'active') continue
    if (!Array.isArray(v)) bad('argsProfiles["' + k + '"] must be an array of CLI args')
    profiles[k] = v.map(String)
  }
  if (Array.isArray(cfg.args)) profiles.normal = cfg.args.map(String)

  const activeRaw = typeof raw.active === 'string' ? raw.active.trim() : ''
  if (Object.keys(profiles).length === 0) {
    // legacy：无任何档位配置 = CLI 默认旗标（normal 空档，不追加权限参数）
    if (activeRaw && activeRaw !== 'normal') {
      bad('active profile "' + activeRaw + '" is not defined (no profiles configured)')
    }
    return { active: 'normal', profiles: { normal: [] }, args: [] }
  }
  if (!profiles.normal) bad('missing a "normal" baseline profile (set args or argsProfiles.normal)')

  const active = activeRaw || 'normal'
  if (!(active in profiles)) {
    bad('active profile "' + active + '" is not defined (have: ' + Object.keys(profiles).join(', ') + ')')
  }
  return { active, profiles, args: profiles[active] }
}

/**
 * 把一个 model 别名 route 需要的 provider 后端解析成出进程 invocation 的一部分：
 * 返回 { model, extraArgs, env, kind }，供调用方拼接 base args / cwd 后交给 provider.mjs。
 * - builtin：codex 内置 OpenAI，不追加任何 -c，模型经 -m 传。
 * - custom（OpenAI-compatible，codex 0.146 仅支持 responses）：追加 -c model_providers.* 覆盖 + env_key。
 *
 * ⚠️ 实测要点（2026-08-18）：`-c model_providers.<id>.name=<id>` **必须**一起给——codex 0.146 的
 * ModelProviderInfo 要求 name 非空，缺它会在 config 加载时直接报
 * `model_providers.<id>: provider name must not be empty`。带 name 后 base_url/wire_api/env_key
 * 覆盖全部生效（第三方 provider 仍需针对目标协议单独验收）。
 */
export function resolveProviderInvocation(providerId, providerDef, modelName) {
  const model = (typeof modelName === 'string' && modelName.trim()) ? modelName.trim() : undefined
  const isBuiltin = providerDef?.type === 'builtin' || !(typeof providerDef?.baseUrl === 'string' && providerDef.baseUrl.trim())
  if (isBuiltin) return { model, modelFlag: '-m', stdinSentinel: '-', extraArgs: [], env: {}, kind: 'builtin' }

  const baseUrl = (providerDef.baseUrl ?? '').trim()
  if (!baseUrl) fail('provider "' + providerId + '" needs either type: builtin or a non-empty baseUrl')
  const wireApi = (providerDef.wireApi ?? 'responses').trim()
  const envKey = (providerDef.envKey ?? providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY').trim()
  const apiKey = resolveSecret(providerDef.apiKey ?? providerDef.apiKeyEnv ?? '')
  const env = {}
  if (apiKey) env[envKey] = apiKey
  const extraArgs = [
    '-c', 'model_providers.' + providerId + '.name=' + providerId,
    '-c', 'model_providers.' + providerId + '.base_url=' + baseUrl,
    '-c', 'model_providers.' + providerId + '.wire_api=' + wireApi,
    '-c', 'model_providers.' + providerId + '.env_key=' + envKey,
    '-c', 'model_provider=' + providerId,
  ]
  return { model, modelFlag: '-m', stdinSentinel: '-', extraArgs, env, kind: 'custom' }
}

/**
 * 解析 codex v2 配置。失败即 throw（fail loud）。
 * @param {object} cfg  config.codex
 * @returns 规范化 spec：
 *   { toolName, command, args, cwd, defaultModel, models: Route[], view }
 *   Route = { alias, provider, model, providerName, modelFlag, stdinSentinel, extraArgs, env, kind }
 *   view  = codex_models 工具直接返回的纯数据。
 */
export function parseCodexConfig(cfg = {}) {
  const toolName = (typeof cfg.toolName === 'string' && cfg.toolName.trim()) ? cfg.toolName.trim() : 'codex'
  const command = (typeof cfg.command === 'string' && cfg.command.trim()) ? cfg.command.trim() : ''
  if (!command) fail('codex.command is required in v2 config')
  const profiles = resolveArgsProfiles(cfg, 'codex')

  // v2.4 resume（session 连续性）：resume 路径 argv 从零构建，resumeArgs 是唯一旗标旋钮，
  // 不与 args/argsProfiles 叠加、不去重（resume 继承原会话沙箱；-c sandbox_mode= 可显式放开）。
  // 默认集：--skip-git-repo-check 是 resume 硬前置（非信任目录不带给它直接报错，实测）；--json 让
  // 续接轮也产结构化事件（resume + --json 回显同一 thread_id，实测）。--ephemeral 会话不落盘、
  // 无法 resume（0.146.0 实测），fail loud 拒绝该组合。
  const resumeArgsRaw = cfg.resumeArgs === undefined ? ['--json', '--skip-git-repo-check'] : cfg.resumeArgs
  if (!Array.isArray(resumeArgsRaw)) fail('codex.resumeArgs must be an array of CLI args')
  const resumeArgs = resumeArgsRaw.map(String)
  if (resumeArgs.some((a) => a === '--ephemeral')) {
    fail('codex.resumeArgs must not contain --ephemeral: ephemeral sessions are never persisted and cannot be resumed')
  }
  if (!resumeArgs.includes('--json')) resumeArgs.push('--json')

  const providers = (cfg.providers && typeof cfg.providers === 'object') ? cfg.providers : {}
  const modelEntries = (cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models)) ? cfg.models : {}
  const aliases = Object.keys(modelEntries)
  if (aliases.length === 0) fail('codex.models must define at least one model alias in v2 config (object map alias -> {provider, model})')

  let defaultModel = (typeof cfg.defaultModel === 'string' && cfg.defaultModel.trim()) ? cfg.defaultModel.trim() : undefined
  if (defaultModel && !(defaultModel in modelEntries)) {
    fail('codex.defaultModel "' + defaultModel + '" is not a key in codex.models')
  }
  if (!defaultModel) defaultModel = aliases[0]

  const models = aliases.map((alias) => {
    const route = modelEntries[alias]
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      fail('codex.models["' + alias + '"] must be an object { provider, model }')
    }
    const provider = (typeof route.provider === 'string' && route.provider.trim()) ? route.provider.trim() : undefined
    if (!provider || !(provider in providers)) {
      fail('codex.models["' + alias + '"] references unknown provider "' + String(provider) + '"')
    }
    const providerDef = providers[provider]
    if (!providerDef || typeof providerDef !== 'object') {
      fail('codex.providers["' + provider + '"] is not an object')
    }
    const model = (typeof route.model === 'string' && route.model.trim()) ? route.model.trim() : alias
    if (Array.isArray(providerDef.models) && !providerDef.models.includes(model)) {
      fail('codex provider "' + provider + '" allowlist [' + providerDef.models.join(', ') + '] does not include model "' + model + '"')
    }
    const inv = resolveProviderInvocation(provider, providerDef, model)
    return {
      alias,
      provider,
      model,
      providerName: 'external:codex:' + alias,
      modelFlag: inv.modelFlag,
      stdinSentinel: inv.stdinSentinel,
      extraArgs: inv.extraArgs,
      env: inv.env,
      kind: inv.kind,
    }
  })

  // v2.4：codex 路由强制 --json（session id 是 resume 的唯一钥匙，「成功必有 id」，
  // 不提供关闭逃生门）；stdout 缓冲提到 256KB（JSONL 事件流，首行 thread.started 保头 + 尾窗保最终回答），
  // stderr 维持共享 maxOutputBytes（仅日志）。spill 由 provider 侧按此配置启用。
  const activeArgs = profiles.args.includes('--json') ? profiles.args : [...profiles.args, '--json']
  return {
    toolName,
    command,
    args: activeArgs,
    argsProfiles: { active: profiles.active, available: Object.keys(profiles.profiles) },
    resumeArgs,
    stdoutMaxBytes: toPositiveInt(cfg.stdoutMaxBytes, 256 * 1024),
    cwd: (typeof cfg.cwd === 'string' && cfg.cwd.trim()) ? cfg.cwd.trim() : undefined,
    defaultModel,
    models,
    modelAliases: aliases,
    modelsView: models.map((r) => ({ alias: r.alias, provider: r.provider, model: r.model, kind: r.kind })),
  }
}

/** 正整数解析；非法回退默认值（缓冲类配置不值得 fail loud）。 */
function toPositiveInt(value, fallback) {
  const n = Number(value)
  return (Number.isFinite(n) && Number.isInteger(n) && n > 0) ? n : fallback
}

/**
 * 解析 claude（Anthropic 协议）的 v1 单工具配置（无模型别名路由）：
 * command/args + 可选 model（--model）+ 可选 provider（ANTHROPIC_BASE_URL/AUTH_TOKEN env）。
 * 仅失败（缺 command / provider 指向未知 id / provider 缺 baseUrl）时 throw。
 */
export function parseClaudeConfig(cfg = {}) {
  const toolName = (typeof cfg.toolName === 'string' && cfg.toolName.trim()) ? cfg.toolName.trim() : 'claude_code'
  const command = (typeof cfg.command === 'string' && cfg.command.trim()) ? cfg.command.trim() : ''
  if (!command) fail('claude.command is required')
  const profiles = resolveArgsProfiles(cfg, 'claude')
  const env = { ...(cfg.env ?? {}) }
  const extraArgs = []
  const providerId = (typeof cfg.provider === 'string' && cfg.provider.trim()) ? cfg.provider.trim() : undefined
  if (providerId) {
    const providers = (cfg.providers && typeof cfg.providers === 'object') ? cfg.providers : {}
    const prov = providers[providerId]
    if (!prov || typeof prov !== 'object') fail('claude.provider "' + providerId + '" not defined in claude.providers')
    const baseUrl = (prov.baseUrl ?? '').trim()
    if (!baseUrl) fail('claude provider "' + providerId + '" needs baseUrl')
    const apiKey = resolveSecret(prov.apiKey ?? prov.apiKeyEnv ?? '')
    env.ANTHROPIC_BASE_URL = baseUrl
    if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey
  }
  return {
    toolName,
    command,
    args: profiles.args,
    argsProfiles: { active: profiles.active, available: Object.keys(profiles.profiles) },
    // v2.5：claude session 连续性。新会话由插件生成新 UUID 走 --session-id（id 在 spawn 前已知，
    // 无需解析输出）；续接由父 agent 传回 session_id 走 --resume。实测（claude 2.1.220）：
    // 同一 id 可多次 --resume；复用已存在 id 走 --session-id 会报 "already in use" 但 exit=0，
    // 因此新会话永远用新 UUID，杜绝碰撞。
    sessionSupport: cfg.session === false ? false : true,
    resumeArg: '--resume',
    newSessionArg: '--session-id',
    cwd: (typeof cfg.cwd === 'string' && cfg.cwd.trim()) ? cfg.cwd.trim() : undefined,
    env,
    extraArgs,
    providerId: providerId ?? 'builtin',
    model: (typeof cfg.model === 'string' && cfg.model.trim()) ? cfg.model.trim() : undefined,
    modelFlag: '--model',
    stdinSentinel: undefined, // claude -p 直接读 stdin，无需 '-' 哨兵
  }
}
