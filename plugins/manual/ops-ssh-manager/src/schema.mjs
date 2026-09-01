// Roster schema + validation (pure, no runtime deps). A "roster" is the
// non-secret config: hosts (code/address/auth/review/sudo) and key metadata.
// Never any secret material — private keys and passwords (incl. sudo) live in
// the credentials seam.
//
// v2 (Phase 1.5, operator-approved, NO forward-compat): every host MUST carry
// sudo: 'none' | 'auto' | 'password'. v1 files fail loud here; the one-shot
// migration is scripts/migrate-roster-v2.mjs.

import { SUDO_MODES, normalizeSudo } from './sudo.mjs'

export const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
export const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const ROSTER_VERSION = 2

export function normalizeCode(value) {
  const s = String(value || '').trim()
  return s === '' ? null : s
}

export function normalizeReview(value) {
  const s = String(value || '').toLowerCase().trim()
  return s === 'strict' ? 'strict' : 'normal'
}

// Strip all control chars (0x00-0x1f + 0x7f, incl. \r \n \0). Used for fields
// that get shell-interpolated (defaultDir) or echoed into UI/audit (alias), so a
// stray newline can never split a `cd '…' && …` command boundary.
function noControl(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

export function validateHost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'host must be an object' }
  }
  const code = normalizeCode(input.code)
  if (!code) return { ok: false, error: 'code (代号) is required' }
  if (!CODE_RE.test(code)) return { ok: false, error: 'code 仅限字母/数字与 ._ - ，长度 1-63' }

  const addr = String(input.host || '').trim()
  if (!addr) return { ok: false, error: 'host (地址) is required' }
  const username = String(input.username || '').trim()
  if (!username) return { ok: false, error: 'username is required' }

  const rawPort = input.port === undefined || input.port === null || input.port === '' ? 22 : Number(input.port)
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    return { ok: false, error: 'port 必须在 1-65535' }
  }

  const authType = input.authType === 'password' ? 'password' : 'key'
  if (authType === 'key') {
    const keyId = String(input.keyId || '').trim()
    if (!keyId) return { ok: false, error: 'key 认证必须提供 keyId' }
    if (!KEY_ID_RE.test(keyId)) return { ok: false, error: 'invalid keyId' }
  }

  // v2: sudo is REQUIRED. Normalize coerces junk to 'auto', but a host object
  // without the field at all is a v1 shape → fail loud (no silent compat).
  if (input.sudo === undefined || input.sudo === null || input.sudo === '') {
    return { ok: false, error: 'sudo 字段缺失（roster v2 要求 none|auto|password；旧文件请先跑 scripts/migrate-roster-v2.mjs）' }
  }
  const sudo = normalizeSudo(input.sudo)
  if (!sudo) {
    return { ok: false, error: 'sudo 仅限 none|auto|password' }
  }

  const out = {
    code,
    alias: noControl(input.alias || code) || code,
    host: addr,
    port: rawPort,
    username,
    authType,
    review: normalizeReview(input.review),
    sudo,
  }
  if (authType === 'key') out.keyId = String(input.keyId).trim()
  if (input.jump) {
    const jump = normalizeCode(input.jump)
    if (jump) out.jump = jump
  }
  {
    const dd = noControl(input.defaultDir)
    if (dd) out.defaultDir = dd
  }
  {
    const fp = noControl(input.fingerprint)
    if (fp) out.fingerprint = fp
  }
  return { ok: true, host: out }
}

export function validateRoster(roster) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) {
    return { ok: false, error: 'roster must be an object' }
  }
  if (Number(roster.version) !== ROSTER_VERSION) {
    return { ok: false, error: 'roster version 必须是 ' + ROSTER_VERSION + '（v1 文件请先跑 scripts/migrate-roster-v2.mjs）' }
  }
  const hosts = Array.isArray(roster.hosts) ? roster.hosts : []
  const keys = Array.isArray(roster.keys) ? roster.keys : []
  const seen = new Set()
  const outHosts = []
  for (const h of hosts) {
    const r = validateHost(h)
    if (!r.ok) return r
    if (seen.has(r.host.code)) return { ok: false, error: 'duplicate code: ' + r.host.code }
    seen.add(r.host.code)
    outHosts.push(r.host)
  }
  return { ok: true, roster: { version: ROSTER_VERSION, hosts: outHosts, keys } }
}

// Public, secret-free view of a host surfaced to the model via ssh_list_hosts.
export function publicHostView(host) {
  return {
    code: host.code,
    alias: host.alias,
    host: host.host,
    username: host.username,
    review: host.review,
    sudo: host.sudo,
  }
}