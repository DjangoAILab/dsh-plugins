// Model-visible tools: ssh_exec + ssh_list_hosts. Pure host logic for the
// strict-mode approval flow (single / session), TOFU enforcement, and audit.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadRoster, dataDir, auditPath, writeAudit, keyRef, passRef, sudoRef, getSecret } from './store.mjs'
import { execCommand } from './ssh.mjs'
import { requestApproval } from './approve.mjs'
import { publicHostView } from './schema.mjs'
import { auditRecord, auditLine } from './audit.mjs'
import { checkElevationContract, SUDO_ERROR_HINTS } from './sudo.mjs'

const DEFAULT_TIMEOUT_MS = 30000

export function mountSshTools(ctx, config = {}) {
  const dir = dataDir(config)
  const auditFile = auditPath(config, dir)
  // sessionId -> { exec:Set<code>, elevate:Set<code> } — dual-key per-session
  // whitelist: host approval and ELEVATION approval are independent grant
  // chains; "本 session 允许了这台主机" never implies elevation rights
  // (DESIGN.md §11.5).
  const sessionApprovals = new Map()

  const credentials = ctx.get('credentials')

  async function resolveHost(code) {
    const roster = await loadRoster(dir)
    return roster.hosts.find((h) => h.code === code)
  }

  async function resolveAuth(host) {
    if (host.authType === 'password') {
      const password = await getSecret(credentials, passRef(host.code))
      return { password }
    }
    const privateKey = await getSecret(credentials, keyRef(host.keyId))
    return { privateKey }
  }

  // Chain B secret: the sudo password (independent of the login password).
  async function resolveSudoPassword(host) {
    if (host.sudo !== 'password') return undefined
    return getSecret(credentials, sudoRef(host.code))
  }

  function sessionKey(agent) {
    // Live Agent carries its session identity on `agent.id` (SessionId),
    // NOT `agent.sessionId` (that field belongs to CreateAgentOptions).
    return agent && agent.id ? String(agent.id) : null
  }
  function isSessionApproved(agent, kind, code) {
    const k = sessionKey(agent)
    if (!k) return false
    const rec = sessionApprovals.get(k)
    return !!(rec && rec[kind] && rec[kind].has(code))
  }
  function markSessionApproved(agent, kind, code) {
    const k = sessionKey(agent)
    if (!k) return
    let rec = sessionApprovals.get(k)
    if (!rec) { rec = { exec: new Set(), elevate: new Set() }; sessionApprovals.set(k, rec) }
    rec[kind].add(code)
  }

  const disposeExec = ctx.tools.register(defineTool({
    name: 'ssh_exec',
    description:
      '在已登记的主机上执行一条 SSH 命令（按代号引用，凭据不出插件）。' +
      '对「严格」审查等级的主机，命令会阻塞并等待操作员批准（允许一次 / 本 session 允许）。' +
      '需要 root 提权时传 elevate:true，且命令本体不要写 sudo（插件统一处理提权与密码注入）；' +
      '命令含 sudo/su/doas 而未声明 elevate 会被拒绝。sudo 密码由插件从凭据安全注入 stdin，绝不经过对话。' +
      '先调用 ssh_list_hosts 获取可用代号。',
    parameters: {
      code: { type: 'string', required: true, description: '目标主机代号（来自 ssh_list_hosts 的 code）。' },
      command: { type: 'string', required: true, description: '要在远端执行的 shell 命令（单条）。提权时写命令本体，不要带 sudo 前缀。' },
      timeout_ms: { type: 'integer', description: '超时毫秒，默认 30000。' },
      elevate: { type: 'boolean', description: 'true=以 root 提权运行 command（sudo 语义）。命令本体不要写 sudo/su/doas。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          approved: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          sudoErrorCode: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) {
          const hint = value.sudoErrorCode && SUDO_ERROR_HINTS[value.sudoErrorCode]
          return [{ type: 'text', text: 'ssh_exec error [' + (value.sudoErrorCode || 'ERROR') + ']: ' + value.error + (hint ? '\n' + hint : '') }]
        }
        const tags = []
        if (value.approved) tags.push('[approved:' + value.approved + ']')
        if (value.note) tags.push('[操作员备注:' + value.note + ']')
        if (typeof value.exitCode === 'number') tags.push('[exit ' + value.exitCode + ']')
        let text = tags.length ? tags.join(' ') + '\n' : ''
        text += value.stdout || ''
        if (value.stderr) text += (text.endsWith('\n') ? '' : '\n') + value.stderr
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('ssh_exec requires a calling agent')
      if (!args.code) throw new Error('ssh_exec requires code')
      if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('ssh_exec requires a command')

      const code = String(args.code).trim()
      const host = await resolveHost(code)
      if (!host) throw new Error('unknown host code: ' + code)

      const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS
      const elevate = args.elevate === true

      // Elevation contract (fail-closed): payload and elevate flag are mutually
      // exclusive — the plugin owns the sudo prefix in both directions.
      const contract = checkElevationContract(args.command, elevate)
      if (contract) {
        await writeAudit(auditFile, auditLine(auditRecord({
          ts: new Date().toISOString(), code, tool: 'ssh_exec',
          args: { command: args.command }, allowed: false,
          sudoErrorCode: contract.errorCode,
        })))
        throw new Error('ssh_exec [' + contract.errorCode + ']: ' + (SUDO_ERROR_HINTS[contract.errorCode] || 'rejected'))
      }

      if (elevate && host.sudo === 'none') {
        await writeAudit(auditFile, auditLine(auditRecord({
          ts: new Date().toISOString(), code, tool: 'ssh_exec',
          args: { command: args.command }, allowed: false, sudoErrorCode: 'ELEVATION_DISABLED',
        })))
        throw new Error('ssh_exec [ELEVATION_DISABLED]: ' + SUDO_ERROR_HINTS.ELEVATION_DISABLED)
      }

      // Approvals: host review gate (exec chain) and elevation gate are
      // independent; when both are needed they are merged into ONE question
      // with a clear「将提权」marker, and granted at their own granularity
      // (DESIGN.md §11.5).
      let approved
      let approvalNote
      let approvalVerdict
      const needHostApproval = host.review === 'strict' && !isSessionApproved(agent, 'exec', code)
      const needElevateApproval = elevate && !isSessionApproved(agent, 'elevate', code)
      if (needHostApproval || needElevateApproval) {
        const decision = await requestApproval(ctx, {
          code, alias: host.alias, command: args.command, agent,
          elevate: needElevateApproval, includeHost: needHostApproval,
        })
        if (decision.verdict === 'denied') {
          await writeAudit(auditFile, auditLine(auditRecord({
            ts: new Date().toISOString(), code, tool: 'ssh_exec',
            args: { command: args.command }, allowed: false, reason: decision.reason,
            elevated: elevate, approval: 'denied',
          })))
          throw new Error('ssh_exec denied on "' + code + '": ' + decision.reason)
        }
        approved = decision.verdict
        approvalNote = decision.note
        approvalVerdict = decision.verdict
        if (decision.verdict === 'session') {
          if (needHostApproval) markSessionApproved(agent, 'exec', code)
          if (needElevateApproval) markSessionApproved(agent, 'elevate', code)
        }
      } else if (elevate && isSessionApproved(agent, 'elevate', code)) {
        approvalVerdict = 'session'
      }

      const auth = await resolveAuth(host)
      if (host.authType === 'key' && !auth.privateKey) {
        await writeAudit(auditFile, auditLine(auditRecord({
          ts: new Date().toISOString(), code, tool: 'ssh_exec',
          args: { command: args.command }, allowed: false, reason: 'auth key missing', elevated: elevate,
        })))
        throw new Error('主机 ' + code + ' 的私钥缺失，请检查密钥登记')
      }
      if (host.authType === 'password' && !auth.password) {
        await writeAudit(auditFile, auditLine(auditRecord({
          ts: new Date().toISOString(), code, tool: 'ssh_exec',
          args: { command: args.command }, allowed: false, reason: 'auth password missing', elevated: elevate,
        })))
        throw new Error('主机 ' + code + ' 的密码缺失，请检查登记')
      }

      if (!host.fingerprint) {
        await writeAudit(auditFile, auditLine(auditRecord({
          ts: new Date().toISOString(), code, tool: 'ssh_exec',
          args: { command: args.command }, allowed: false, reason: 'fingerprint not pinned',
        })))
        throw new Error('主机 ' + code + ' 未固定指纹（TOFU），请先在管理页测试并固定')
      }

      const sudoPassword = elevate ? await resolveSudoPassword(host) : undefined
      const result = await execCommand({
        host: host.host, port: host.port, username: host.username,
        privateKey: auth.privateKey, password: auth.password,
        expectedFingerprint: host.fingerprint,
        command: args.command, cwd: host.defaultDir, timeoutMs,
        elevate, sudoPassword,
      })

      await writeAudit(auditFile, auditLine(auditRecord({
        ts: new Date().toISOString(), code, tool: 'ssh_exec',
        args: { command: args.command }, allowed: true,
        exitCode: result.exitCode, success: result.ok, error: result.error,
        elevated: elevate, elevatePath: result.elevatePath,
        sudoErrorCode: result.sudoErrorCode, approval: approvalVerdict,
      })))

      if (!result.ok) {
        const err = new Error('ssh_exec failed on "' + code + '": ' + (result.error || 'unknown error'))
        err.sudoErrorCode = result.sudoErrorCode
        err.stderr = result.stderr
        throw err
      }

      const out = { code, stdout: result.stdout || '', stderr: result.stderr || '' }
      if (typeof result.exitCode === 'number') out.exitCode = result.exitCode
      if (approved) out.approved = approved
      if (approvalNote) out.note = approvalNote
      return out
    },
  }))

  const disposeList = ctx.tools.register(defineTool({
    name: 'ssh_list_hosts',
    description: '列出已登记的 SSH 主机（代号、备注、地址、用户、审查等级）。不含任何凭据。',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            code: { type: 'string', required: true },
            alias: { type: 'string' },
            host: { type: 'string', required: true },
            username: { type: 'string', required: true },
            review: { type: 'string', required: true },
            sudo: { type: 'string', required: true },
          },
        },
      },
      render: (_args, value) => {
        if (!value || !value.length) return [{ type: 'text', text: '(no hosts registered)' }]
        const lines = value.map((h) => '- ' + h.code + '  ' + (h.alias || '') + '  ' + h.username + '@' + h.host
          + '  [review:' + h.review + ']  [sudo:' + (h.sudo || 'auto') + ']')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const roster = await loadRoster(dir)
      return roster.hosts.map(publicHostView)
    },
  }))

  return () => { disposeExec(); disposeList() }
}