import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, auditLine, auditRecord } from '../src/audit.mjs'

test('redact: blanks secret-named fields, case insensitive', () => {
  const out = redact({ password: 's3cret', PASSphrase: 'x', apikey: 'k', host: 'h', nested: { token: 't', user: 'u' } })
  assert.equal(out.password, '***')
  assert.equal(out.PASSphrase, '***')
  assert.equal(out.apikey, '***')
  assert.equal(out.host, 'h')
  assert.equal(out.nested.token, '***')
  assert.equal(out.nested.user, 'u')
})

test('redact: passes through scalars and arrays', () => {
  assert.equal(redact(42), 42)
  assert.equal(redact('x'), 'x')
  assert.deepEqual(redact([{ password: 'p' }]), [{ password: '***' }])
})

test('auditLine: emits one JSON line', () => {
  const line = auditLine({ ts: '2026-08-19T00:00:00Z', code: 'prod', tool: 'ssh_exec', allowed: false })
  assert.equal(line, '{"ts":"2026-08-19T00:00:00Z","code":"prod","tool":"ssh_exec","allowed":false}\n')
})

test('auditRecord: redacts args and slices long error', () => {
  const r = auditRecord({
    ts: 't', code: 'p', tool: 'ssh_exec', args: { command: 'rm -rf /', password: 'pw' },
    allowed: false, reason: 'denied', exitCode: 0, success: false, error: 'x'.repeat(1000),
  })
  assert.equal(r.args.password, '***')
  assert.equal(r.args.command, 'rm -rf /')
  assert.equal(r.error.length, 500)
  assert.equal(r.exitCode, 0)
})