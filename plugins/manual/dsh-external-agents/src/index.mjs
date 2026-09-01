// dsh-external-agents index.mjs
// cordis 插件入口。v2（见 DESIGN.md）：
//   - codex：解耦成「单工具 codex + model 参数」+ 内部 route provider（每模型别名一个 provider）。
//     模型/Provider 全走插件配置（providers/models/defaultModel），与 DSH 主模型选择器无关。
//     异步 = 原生 ctx.jobs（后台 Job）+ settleRun，不重造。
//   - claude：自写单工具 claude_code（Anthropic 协议），同样不依赖 dsh-tool-subagent。
// 配置错误在 apply 即 throw（fail loud），绝不静默降级。

import { createCliProvider } from './provider.mjs'
import { parseCodexConfig, parseClaudeConfig } from './route.mjs'
import { mountCodexTools, mountSingleTool } from './tool.mjs'
import { validateConfiguredCwd } from '@deepseek-ai/dsh-subagent'

export const name = 'dsh-external-agents'
export const inject = ['subagents', 'subprocess', 'tools']

const DEFAULT_GRACE_MS = 15000
const DEFAULT_MAX_OUTPUT_BYTES = 50000

function toPositiveFinite(value, fallback) {
  const n = Number(value)
  return (Number.isFinite(n) && n > 0) ? n : fallback
}

function hasCommand(cfg) {
  return Boolean(cfg && typeof cfg.command === 'string' && cfg.command.trim())
}

export function apply(ctx, config = {}) {
  const warn = (message) => {
    try { ctx.logger?.warn?.('[' + name + ']', message) } catch { /* 日志失败绝不致命 */ }
  }
  const info = (message) => {
    try { ctx.logger?.info?.('[' + name + ']', message) } catch { /* 日志失败绝不致命 */ }
  }
  const graceMs = toPositiveFinite(config.graceMs, DEFAULT_GRACE_MS)
  const maxOutputBytes = toPositiveFinite(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)

  // ---------- codex：v2 单工具 + model 参数 + route provider ----------
  const cx = config.codex
  if (cx && cx.enabled === false) {
    warn('codex 已禁用（enabled: false），跳过')
  } else if (hasCommand(cx)) {
    const spec = parseCodexConfig(cx) // 任何配置错误在此 throw（fail loud）
    ctx.effect(() => {
      const disposers = []
      for (const route of spec.models) {
        const invocation = {
          command: spec.command,
          args: spec.args,
          cwd: validateConfiguredCwd('external-agents:' + route.providerName, spec.cwd),
          env: route.env,
          model: route.model,
          modelFlag: route.modelFlag,
          stdinSentinel: route.stdinSentinel,
          extraArgs: route.extraArgs,
        }
        disposers.push(ctx.subagents.registerProvider(createCliProvider({ ctx, name: route.providerName, config: invocation, codex: { resumeArgs: spec.resumeArgs, stdoutMaxBytes: spec.stdoutMaxBytes }, graceMs, maxOutputBytes })))
      }
      disposers.push(mountCodexTools(ctx, spec))
      return () => { for (const d of disposers) { try { d() } catch { /* 忽略卸载失败 */ } } }
    })
    info('codex v2 mounted: ' + spec.modelAliases.length + ' route provider(s), default model "' + spec.defaultModel
      + '", args profile "' + spec.argsProfiles.active + '" (available: ' + spec.argsProfiles.available.join(', ')
      + '); switch profile = edit config + reinstall + restart DSH')
  } else {
    warn('codex 未配置 command，跳过 codex 工具（v2 单工具 + model 参数）')
  }

  // ---------- claude：自写单工具（Anthropic 协议） ----------
  const claude = config.claude
  if (claude && claude.enabled === false) {
    warn('claude 已禁用（enabled: false），跳过')
  } else if (hasCommand(claude)) {
    const cs = parseClaudeConfig(claude)
    const providerName = 'external:claude'
    const invocation = {
      command: cs.command,
      args: cs.args,
      cwd: validateConfiguredCwd('external-agents:' + providerName, cs.cwd),
      env: cs.env,
      model: cs.model,
      modelFlag: cs.modelFlag,
      stdinSentinel: cs.stdinSentinel,
      extraArgs: cs.extraArgs,
    }
    // 注意：claude 的模型由 config.claude.model 在 apply 时烘焙进 provider，调用时不暴露 model 参数
    //（对外进程 provider 而言，agentOptions/model 在子进程侧不生效）。
    ctx.effect(() => {
      const disposers = [
        ctx.subagents.registerProvider(createCliProvider({ ctx, name: providerName, config: invocation, claudeSession: cs.sessionSupport ? { resumeArg: cs.resumeArg, newSessionArg: cs.newSessionArg } : undefined, graceMs, maxOutputBytes })),
        mountSingleTool(ctx, {
          toolName: cs.toolName,
          providerName,
          body: '把一个自包含任务交给外部 agent（claude）在独立上下文里一次性跑完。当前权限档位 '
            + cs.argsProfiles.active + '（档位由部署者在插件 config 的 argsProfiles 里定义，模型不可切换）。'
            + '同步阻塞等 CLI 结束；run_in_background: true 则返回后台 Job id（收数：完成自动通知，或 job_output(wait:true) 带上限等待；不要 sleep/轮询）。'
            + (cs.sessionSupport ? '结果末尾附带 session id 行；要在同一 claude 会话上继续迭代，把它原样传回 session_id 参数（省略 = 全新会话）。' : ''),
          modelInfo: undefined,
          sessionSupport: cs.sessionSupport,
        }),
      ]
      return () => { for (const d of disposers) { try { d() } catch { /* 忽略卸载失败 */ } } }
    })
    info('claude mounted: provider "' + cs.providerId + '", args profile "' + cs.argsProfiles.active
      + '" (available: ' + cs.argsProfiles.available.join(', ')
      + '); switch profile = edit config + reinstall + restart DSH')
  } else {
    warn('claude 未配置 command，跳过 claude 工具')
  }
}