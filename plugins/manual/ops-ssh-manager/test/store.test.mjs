import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyRef, passRef, sudoRef, migrateRosterV1 } from '../src/store.mjs'

test('keyRef: injective across - _ . and space', () => {
  const seen = new Set()
  for (const id of ['a-b', 'a_b', 'a.b', 'a b', 'prod-01', 'prod_01', 'prod.01']) {
    const r = keyRef(id)
    assert.ok(!seen.has(r), 'collision: ' + JSON.stringify(id) + ' -> ' + r)
    seen.add(r)
  }
})

test('passRef: injective across - _ .', () => {
  const seen = new Set()
  for (const c of ['a-b', 'a_b', 'a.b', 'prod01', 'prod.01', 'prod-01']) {
    const r = passRef(c)
    assert.ok(!seen.has(r), 'collision: ' + JSON.stringify(c) + ' -> ' + r)
    seen.add(r)
  }
})

test('refs are POSIX-style identifiers', () => {
  for (const r of [keyRef('a-b'), passRef('prod.01'), keyRef('k1'), passRef('x')]) {
    assert.match(r, /^(OPSSSH_KEY_|OPSSSH_PASS_)[A-Za-z0-9_]+$/)
  }
})
test('sudoRef: injective and namespaced away from login refs', () => {
  const seen = new Set()
  for (const c of ['a-b', 'a_b', 'a.b', 'prod-01', 'x']) {
    const r = sudoRef(c)
    assert.ok(!seen.has(r), 'collision: ' + c)
    seen.add(r)
    assert.match(r, /^OPSSSH_SUDO_[A-Za-z0-9_]+$/)
  }
  // never collides with the login-password ref for the same code
  assert.notEqual(sudoRef('prod-01'), passRef('prod-01'))
})

test('migrateRosterV1: adds sudo=auto to every host, bumps version, validates', () => {
  const v1 = { version: 1, hosts: [
    { code: 'a', host: 'h1', username: 'u', authType: 'password', review: 'strict', fingerprint: 'fp' },
    { code: 'b', host: 'h2', username: 'u', authType: 'key', keyId: 'k1', defaultDir: '/srv' },
  ], keys: [{ id: 'k1', name: 'k', pubkey: 'pub', createdAt: 't' }] }
  const m = migrateRosterV1(v1)
  assert.equal(m.ok, true)
  assert.equal(m.roster.version, 2)
  assert.deepEqual(m.roster.hosts.map((h) => h.sudo), ['auto', 'auto'])
  // non-sudo fields preserved
  assert.equal(m.roster.hosts[0].review, 'strict')
  assert.equal(m.roster.hosts[1].defaultDir, '/srv')
})

test('migrateRosterV1: v2 input passes through, garbage fails loud', () => {
  const v2 = { version: 2, hosts: [{ code: 'a', host: 'h', username: 'u', authType: 'password', sudo: 'none' }], keys: [] }
  assert.deepEqual(migrateRosterV1(v2).roster, v2)
  assert.equal(migrateRosterV1(null).ok, false)
  assert.equal(migrateRosterV1([1]).ok, false)
  // a host that cannot be completed (missing required fields) fails loud
  assert.equal(migrateRosterV1({ version: 1, hosts: [{ code: 'x' }], keys: [] }).ok, false)
})
