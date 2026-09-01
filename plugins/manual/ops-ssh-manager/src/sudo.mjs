// Sudo elevation policy & two-phase protocol helpers (pure, no runtime deps).
//
// Protocol (DESIGN.md §11.2, exit-code + marker driven — stderr text is locale
// dependent [zh/en both observed on real machines] and never decides a branch,
// it only enriches the final hint):
//   probe : `sudo -n true` (management capability test; never prompts)
//   phase1: `sudo -n /bin/sh -c 'echo MARKER >&2; <command>'`
//           marker present → NOPASSWD, command executed, rc = command's rc
//           (this is how a command's own rc=1 is distinguished from "sudo
//           wants a password" — Codex review item 2)
//           no marker, rc≠0 → sudo refused before running anything → phase 2
//   phase2: `sudo -S -p '' /bin/sh -c 'echo MARKER >&2; <command>'`
//           + one password line written to channel stdin, then EOF
//           marker present → sudo exec'd sh: rc = command's rc (any value)
//           no marker → sudo refused; classify via text (best effort)
//
// The marker is built by the INNER shell from two string halves so the literal
// never appears in the command text: sudo's own denial messages quote the
// command and could otherwise fake a marker.
//
// Elevation contract (fail-closed, operator-decided): the command payload and
// the `elevate` flag are mutually exclusive — the plugin owns the sudo prefix,
// so a command that carries its own sudo/su/doas token is rejected in both
// directions.

export const SUDO_MODES = ['none', 'auto', 'password']

// Separator-anchored token match: `visudo`, `/etc/sudoers`, `systemctl status`
// never match; `sudo`, `; sudo`, `'sudo'`, `/usr/bin/sudo`, `$(sudo …)` do.
// Known boundary (review M1): shell-escape obfuscation like `s\\udo` or
// `$'s'udo` is NOT matched — the model could route around the guard that way,
// but that is a deliberate prompt-level bypass, audited verbatim in the
// command log, not the guard's threat model.
const TOKEN_LEAD = /(^|[\s;&|()'"\[\/])/
const TOKEN_TRAIL = /([\s;&|()'"#]|$)/
const ELEVATION_TOKENS = ['sudo', 'su', 'doas']
const TOKEN_RES = ELEVATION_TOKENS.map((t) => new RegExp(TOKEN_LEAD.source + t + TOKEN_TRAIL.source))

export function commandHasElevationToken(command) {
  if (typeof command !== 'string') return false
  return TOKEN_RES.some((re) => re.test(command))
}

export function checkElevationContract(command, elevate) {
  const hasToken = commandHasElevationToken(command)
  if (hasToken && !elevate) {
    return { errorCode: 'SUDO_TOKEN_WITHOUT_ELEVATE' }
  }
  if (hasToken && elevate) {
    return { errorCode: 'SUDO_DOUBLE_ELEVATION' }
  }
  return null
}

// Strict: valid enum in → value; anything else → null. The only caller allowed
// to coerce junk to 'auto' is the v1 migration (coerceSudoForMigration).
export function normalizeSudo(value) {
  const s = String(value == null ? '' : value).toLowerCase().trim()
  return SUDO_MODES.includes(s) ? s : null
}
// Migration-only fallback (the single operator-approved default).
export function coerceSudoForMigration(value) {
  return normalizeSudo(value) || 'auto'
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// Protocol building blocks (single source of truth; unit-tested).
export const SUDO_PROBE_COMMAND = 'sudo -n true'
// The assembled marker value; its two halves are embedded separately in the
// wrapped command text so the LITERAL never appears there — sudo's denial
// messages quote the command, and could otherwise fake the marker.
export const SUDO_EXEC_MARKER = '__OPS' + 'SSH_EXEC__'
const MARKER_HALVES = ["'__OPS'", "'SSH_EXEC__'"] // inner-sh adjacent concat
const MARKER_ECHO = 'echo ' + MARKER_HALVES[0] + MARKER_HALVES[1] + ' >&2'
export function sudoExecShell(command) {
  const inner = MARKER_ECHO + '; ' + command
  return 'sudo -n ' + shellQuote('/bin/sh') + ' -c ' + shellQuote(inner)
}
export function sudoAskpassShell(command) {
  const inner = MARKER_ECHO + '; ' + command
  return "sudo -S -p '' " + shellQuote('/bin/sh') + ' -c ' + shellQuote(inner)
}
export function sudoPasswordFrame(password) { return String(password) + '\n' }

// Phase classification. Exit-code + marker driven.
//   marker seen  → the inner sh ran (sudo auth passed, command executed).
//   rc=127       → no sudo binary (busybox routers).
//   other rc≠0   → sudo refused before running anything (password needed).
export function classifySudoPhase(closeCode, stderr, sawMarker) {
  if (sawMarker) return { kind: 'executed' }
  const code = Number(closeCode)
  const errText = String(stderr || '')
  if (code === 0) return { kind: 'failed' } // sudo exited 0 without running sh: not trustworthy
  if (code === 127) return { kind: 'no-sudo' }
  if (/sudo.*not found/i.test(errText) || /not found.*sudo/i.test(errText)) return { kind: 'no-sudo' }
  return { kind: 'password' }
}

// Classify a refused run (marker ABSENT) into sudo-level errors. Text is
// best-effort only — the branch does not depend on it. Password text can never
// appear here: sudo does not echo it.
export function classifySudoRunError(stderr) {
  const t = String(stderr || '')
  if (/incorrect password/i.test(t) || /no password was provided/i.test(t) ||
      /authentication failure/i.test(t) || /认证失败/i.test(t)) return 'SUDO_AUTH_FAILED'
  if (/not allowed to execute/i.test(t) || /not in the sudoers file/i.test(t) ||
      /command not allowed/i.test(t) || /不允许执行/i.test(t)) return 'SUDO_POLICY_DENIED'
  return null
}

// Model-facing guidance per error code (never contains secrets).
export const SUDO_ERROR_HINTS = {
  SUDO_TOKEN_WITHOUT_ELEVATE:
    '命令包含 sudo/su/doas 词但未声明提权：确需提权请传 elevate:true 并去掉命令里的 sudo 前缀（插件统一加）；' +
    '若只是引用词面（如 grep 日志里的 "sudo"），请改写命令（如 sud[o]）后重试。',
  SUDO_DOUBLE_ELEVATION:
    'elevate:true 时命令本体不要再写 sudo/su/doas，插件会统一加提权前缀；请去掉命令中的 sudo 后重试。',
  ELEVATION_DISABLED:
    '该主机未启用 sudo 提权（sudo:none）：请操作员在管理页主机编辑里打开「启用提权」。',
  SUDO_NOT_FOUND:
    '该主机没有安装 sudo：无法提权，请操作员安装 sudo 或改用其他方式。',
  SUDO_PASSWORD_REQUIRED:
    '该主机 sudo 需要密码且未登记：请操作员在管理页主机编辑里填写 sudo 密码（或在远端配置 NOPASSWD）。',
  SUDO_AUTH_FAILED:
    'sudo 密码认证失败（单次尝试，绝不重试以避免触发 fail2ban）：请操作员核对管理页登记的 sudo 密码。',
  SUDO_POLICY_DENIED:
    '远端 sudoers 拒绝执行该命令：请操作员调整远端 sudoers（或配置受限 NOPASSWD 白名单）。',
  SUDO_FAILED:
    'sudo 执行失败（sudo 本身未放行或异常，命令未被执行）。',
}