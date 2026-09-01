import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateHost, validateRoster, normalizeCode, publicHostView, ROSTER_VERSION } from '../src/schema.mjs'

const V2 = { sudo: 'auto' } // shared v2 fixture field

test('validateHost: requires code/addr/username', () => {
  assert.equal(validateHost({}).ok, false)
  assert.equal(validateHost({ code: 'prod', host: '', username: 'root', ...V2 }).ok, false)
  assert.equal(validateHost({ code: 'prod', host: '1.2.3.4', ...V2 }).ok, false)
})

test('validateHost (v2): sudo field is REQUIRED, enum-locked, junk rejected', () => {
  // missing sudo = v1 shape → fail loud (no silent compat)
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', authType: 'password' }).ok, false)
  assert.match(
    validateHost({ code: 'p', host: 'h', username: 'u', authType: 'password' }).error,
    /sudo/,
  )
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', authType: 'password', sudo: 'weird' }).ok, false)
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', authType: 'password', sudo: 'inherit-login' }).ok, false)
  for (const mode of ['none', 'auto', 'password']) {
    const r = validateHost({ code: 'p', host: 'h', username: 'u', authType: 'password', sudo: mode })
    assert.equal(r.ok, true, mode)
    assert.equal(r.host.sudo, mode)
  }
})

test('validateHost: normalizes port default', () => {
  const r = validateHost({ code: 'prod', host: '1.2.3.4', username: 'root', authType: 'password', ...V2 })
  assert.equal(r.ok, true)
  assert.equal(r.host.port, 22)
  assert.equal(r.host.review, 'normal')
})

test('validateHost: rejects bad port', () => {
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', port: 99999, ...V2 }).ok, false)
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', port: 0, ...V2 }).ok, false)
})

test('validateHost: key auth requires keyId', () => {
  assert.equal(validateHost({ code: 'p', host: 'h', username: 'u', authType: 'key', ...V2 }).ok, false)
  const r = validateHost({ code: 'p', host: 'h', username: 'u', authType: 'key', keyId: 'k1', ...V2 })
  assert.equal(r.ok, true)
  assert.equal(r.host.keyId, 'k1')
})

test('validateHost: rejects invalid code format', () => {
  assert.equal(validateHost({ code: 'bad code!', host: 'h', username: 'u', ...V2 }).ok, false)
})

test('validateRoster: rejects duplicate codes', () => {
  const r = validateRoster({ version: ROSTER_VERSION, hosts: [
    { code: 'a', host: 'h1', username: 'u', authType: 'password', sudo: 'auto' },
    { code: 'a', host: 'h2', username: 'u', authType: 'password', sudo: 'auto' },
  ] })
  assert.equal(r.ok, false)
  assert.match(r.error, /duplicate/)
})

test('validateRoster (v2): wrong version fails loud with migration hint', () => {
  const hosts = [{ code: 'a', host: 'h1', username: 'u', authType: 'password', sudo: 'auto' }]
  assert.equal(validateRoster({ hosts }).ok, false)
  assert.match(validateRoster({ hosts }).error, /migrate/)
  assert.equal(validateRoster({ version: 1, hosts }).ok, false)
})

test('publicHostView (v2): exposes sudo mode, never secrets', () => {
  const view = publicHostView({ code: 'p', alias: 'Prod', host: '1.2.3.4', username: 'root', review: 'strict', sudo: 'password', keyId: 'k1', fingerprint: 'xx', port: 22, defaultDir: '/srv' })
  assert.deepEqual(Object.keys(view).sort(), ['alias', 'code', 'host', 'review', 'sudo', 'username'])
  assert.equal(view.sudo, 'password')
})

test('publicHostView: only non-secret fields', () => {
  const view = publicHostView({ code: 'p', alias: 'Prod', host: '1.2.3.4', username: 'root', review: 'strict', sudo: 'auto', keyId: 'k1', fingerprint: 'xx', port: 22, defaultDir: '/srv' })
  assert.deepEqual(Object.keys(view).sort(), ['alias', 'code', 'host', 'review', 'sudo', 'username'])
})

test('validateHost: strips control chars from defaultDir/alias/fingerprint', () => {
  const r = validateHost({
    code: 'p', host: 'h', username: 'u', authType: 'password', sudo: 'auto',
    defaultDir: '/srv\nrm -rf /', alias: 'a\nb', fingerprint: 'ab\ncd',
  })
  assert.equal(r.ok, true)
  assert.equal(r.host.defaultDir, '/srvrm -rf /') // \n removed → won't split `cd '…' && …`
  assert.equal(r.host.alias, 'ab')
  assert.equal(r.host.fingerprint, 'abcd')
})