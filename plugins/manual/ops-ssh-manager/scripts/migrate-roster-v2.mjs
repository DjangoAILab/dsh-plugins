#!/usr/bin/env node
// One-shot roster v1 → v2 migration (operator-approved: NO forward-compat in
// the runtime — loadRoster fails loud on v1; this script is the only path).
// Adds sudo:'auto' to every host, bumps version to 2, and keeps the original
// file as roster.v1.bak.json. Idempotent: exits 0 with a notice when the
// roster is already v2. Run: node scripts/migrate-roster-v2.mjs [dataDir]

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { validateRoster } from '../src/schema.mjs'
import { migrateRosterV1 } from '../src/store.mjs'

const argDir = process.argv[2] && String(process.argv[2])
const dir = argDir || join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'ops-ssh-manager')
const rosterFile = join(dir, 'roster.json')

let raw
try {
  raw = JSON.parse(await readFile(rosterFile, 'utf8'))
} catch (e) {
  if (e && e.code === 'ENOENT') {
    console.log('no roster at %s — nothing to migrate', rosterFile)
    process.exit(0)
  }
  console.error('cannot read roster:', e.message)
  process.exit(1)
}

if (Number(raw && raw.version) === 2) {
  // Validate self-declared v2 (review UNCERTAIN fix): a corrupt "v2" file must
  // not silently pass.
  const check = validateRoster(raw)
  if (!check.ok) {
    console.error('roster declares v2 but is invalid:', check.error)
    process.exit(1)
  }
  console.log('roster at %s is already v2 and valid — nothing to do', rosterFile)
  process.exit(0)
}

const m = migrateRosterV1(raw)
if (!m.ok) {
  console.error('migration failed (fail loud, nothing written):', m.error)
  process.exit(1)
}

await writeFile(join(dir, 'roster.v1.bak.json'), JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
await writeFile(rosterFile, JSON.stringify(m.roster, null, 2) + '\n', { mode: 0o600 })
const check = validateRoster(m.roster)
if (!check.ok) {
  console.error('post-migration validation failed:', check.error)
  process.exit(1)
}
console.log('migrated %d host(s) to roster v2 (sudo=auto); backup: roster.v1.bak.json', m.roster.hosts.length)