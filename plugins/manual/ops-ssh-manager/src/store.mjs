// Roster + secret persistence. The roster is NON-secret config (hosts, key
// metadata, review levels, TOFU fingerprints) on a local JSON file; private
// keys and passwords live in the DSH credentials seam and never touch this
// file. Only node builtins + ./schema.mjs imported, so the validation logic
// stays unit-testable.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { validateRoster, ROSTER_VERSION } from './schema.mjs'
import { coerceSudoForMigration } from './sudo.mjs'

// Resolve the plugin data dir: config.dataDir wins, else $DSH_HOME/ops-ssh-manager.
export function dataDir(config) {
  if (!config || typeof config !== 'object') config = {}
  const base = typeof config.dataDir === 'string' && config.dataDir !== ''
    ? config.dataDir
    : (process.env.DSH_HOME || join(os.homedir(), '.dsh'))
  return join(base, 'ops-ssh-manager')
}

export function rosterPath(dir) { return join(dir, 'roster.json') }
export function auditPath(config, dir) {
  return (config && typeof config.auditLog === 'string' && config.auditLog !== '')
    ? config.auditLog
    : join(dir, 'audit.jsonl')
}

export async function loadRoster(dir) {
  try {
    const raw = await readFile(rosterPath(dir), 'utf8')
    const r = validateRoster(JSON.parse(raw))
    if (!r.ok) throw new Error('roster.json invalid: ' + r.error)
    return r.roster
  } catch (e) {
    if (e && e.code === 'ENOENT') return { version: ROSTER_VERSION, hosts: [], keys: [] }
    // Corrupt or malformed roster: fail loud, never silently show an empty list.
    throw e
  }
}

export async function saveRoster(dir, roster) {
  const r = validateRoster(roster)
  if (!r.ok) throw new Error('invalid roster: ' + r.error)
  await mkdir(dir, { recursive: true })
  await writeFile(rosterPath(dir), JSON.stringify(r.roster, null, 2) + '\n', { mode: 0o600 })
  return r.roster
}

export async function writeAudit(file, line) {
  try {
    await appendFile(file, line, { mode: 0o600 })
  } catch {
    // Auditing must never break tool execution (mcp-ssh-manager audit.js rule).
  }
}

// Secret refs must be POSIX shell identifiers (credential seam contract).
// Hex-encode the id to stay injective: code/keyId may legitimately contain `-`
// or `.`, and a naive replace(non-word → '_') would collide ("a-b" vs "a_b").
function refOf(prefix, id) {
  return prefix + Buffer.from(String(id == null ? '' : id), 'utf8').toString('hex')
}
export function keyRef(keyId) { return refOf('OPSSSH_KEY_', keyId) }
export function passRef(code) { return refOf('OPSSSH_PASS_', code) }
// Independent sudo password (chain B) — distinct from the login password so a
// key-auth host can still carry one.
export function sudoRef(code) { return refOf('OPSSSH_SUDO_', code) }

// v1 → v2 (one-shot, used by scripts/migrate-roster-v2.mjs; the runtime never
// auto-migrates — loadRoster fails loud on v1 by design). Every host gets the
// single allowed fallback default sudo:'auto'.
export function migrateRosterV1(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'roster must be an object' }
  }
  if (Number(raw.version) === ROSTER_VERSION) return { ok: true, roster: raw }
  const hosts = Array.isArray(raw.hosts) ? raw.hosts : []
  const keys = Array.isArray(raw.keys) ? raw.keys : []
  const outHosts = hosts.map((h) => (h && typeof h === 'object' && !Array.isArray(h))
    ? { ...h, sudo: coerceSudoForMigration(h.sudo) }
    : h)
  const check = validateRoster({ version: ROSTER_VERSION, hosts: outHosts, keys })
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, roster: check.roster }
}

export async function getSecret(credentials, ref) {
  if (!credentials) return undefined
  const r = await credentials.resolve(ref)
  return r ? r.value : undefined
}
export async function setSecret(credentials, ref, value) {
  if (value === undefined || value === null || value === '') {
    await credentials.unset(ref)
    return
  }
  await credentials.set(ref, String(value))
}
export async function unsetSecret(credentials, ref) {
  await credentials.unset(ref)
}