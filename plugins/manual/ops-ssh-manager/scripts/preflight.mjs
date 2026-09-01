// Preflight: verify the host entry shape and that peers/deps are resolvable in
// the INSTALLED copy (the source tree does not install its peers — see the
// plugin README). Run: node scripts/preflight.mjs

import { name, inject, apply } from '../src/index.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ssh2 from 'ssh2'

const failures = []
function check(cond, msg) { if (!cond) failures.push(msg) }

check(typeof name === 'string' && name === 'ops-ssh-manager', 'plugin name must be "ops-ssh-manager"')
check(Array.isArray(inject) && inject.includes('credentials') && inject.includes('tools') && inject.includes('webServer'), 'inject must list credentials/tools/webServer')
check(typeof apply === 'function', 'apply must be a function')
check(typeof defineTool === 'function', '@deepseek-ai/dsh-tools must export defineTool')
check(Boolean(ssh2 && (ssh2.Client || ssh2.utils)), 'ssh2 must be installed')

if (failures.length) {
  console.error('ops-ssh-manager preflight FAILED:')
  for (const f of failures) console.error(' - ' + f)
  process.exit(1)
}

console.log('ops-ssh-manager preflight OK: name=%s inject=%j', name, inject)