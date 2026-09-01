// Audit redaction + JSONL line builder (pure). Migrated from mcp-ssh-manager
// `src/audit.js`: a field-name denylist redacts secrets to '***' regardless of
// how they arrived; the entry is a single greppable JSON line.

const REDACT_FIELDS = new Set([
  'password', 'passphrase', 'sudopassword', 'sudo_password', 'token', 'secret', 'apikey', 'api_key',
])
const REDACTED = '***'

export function redact(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_FIELDS.has(k.toLowerCase()) ? REDACTED : redact(v)
  }
  return out
}

// Build one sanitized JSONL audit record. `fields` is plain JSON-ownable data.
export function auditLine(fields) {
  return JSON.stringify(fields) + '\n'
}

export function auditRecord({ ts, code, tool, args, allowed, reason, exitCode, success, error, elevated, elevatePath, sudoErrorCode, approval }) {
  const entry = { ts, code, tool, args: redact(args || {}), allowed: !!allowed }
  if (reason !== undefined) entry.reason = reason
  if (typeof exitCode === 'number') entry.exitCode = exitCode
  if (typeof success === 'boolean') entry.success = success
  if (error !== undefined) entry.error = String(error).slice(0, 500)
  // sudo elevation (Phase 1.5): elevated/elevatePath/errorCode/approval verdict.
  // Secret-free by construction — the sudo password only ever flows via stdin.
  if (elevated) entry.elevated = true
  if (elevatePath) entry.elevatePath = elevatePath
  if (sudoErrorCode) entry.sudoErrorCode = sudoErrorCode
  if (approval) entry.approval = approval
  return entry
}