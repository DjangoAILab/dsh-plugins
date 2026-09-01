import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUDO_MODES, SUDO_PROBE_COMMAND, SUDO_ERROR_HINTS, SUDO_EXEC_MARKER,
  commandHasElevationToken, checkElevationContract, normalizeSudo,
  sudoExecShell, sudoAskpassShell, sudoPasswordFrame,
  classifySudoPhase, classifySudoRunError, shellQuote,
} from '../src/sudo.mjs'

test('token guard: catches plain and wrapped sudo/su/doas', () => {
  const positives = [
    'sudo systemctl restart nginx',
    'sudo -n rm -rf /',
    'cd /srv && sudo systemctl restart app',
    '; sudo x',
    "$(sudo whoami)",
    "'sudo' x",
    '/usr/bin/sudo systemctl x',
    'echo st | sudo tee /etc/fstab',
    'su -',
    'su -c "id"',
    'doas restart app',
    'sudo',
    '  sudo',
  ]
  for (const c of positives) {
    assert.ok(commandHasElevationToken(c), 'should match: ' + JSON.stringify(c))
  }
})

test('token guard: ignores words merely containing s-u-o letters', () => {
  const negatives = [
    'systemctl status nginx',
    'visudo -f /etc/sudoers',
    'cat /etc/sudoers',
    'grep sudoers /var/log/auth.log',
    'echo sudofan',
    'uptime',
    'ps aux',
    'summarize log.txt',
    'ls -la',
    '',
  ]
  for (const c of negatives) {
    assert.equal(commandHasElevationToken(c), false, 'should NOT match: ' + JSON.stringify(c))
  }
})

test('elevation contract: token XOR elevate (both directions fail-closed)', () => {
  assert.equal(checkElevationContract('systemctl restart nginx', true), null)
  assert.equal(checkElevationContract('df -h', false), null)
  assert.equal(checkElevationContract('sudo systemctl restart nginx', false)?.errorCode, 'SUDO_TOKEN_WITHOUT_ELEVATE')
  assert.equal(checkElevationContract('sudo systemctl restart nginx', true)?.errorCode, 'SUDO_DOUBLE_ELEVATION')
  assert.equal(checkElevationContract('su - root', true)?.errorCode, 'SUDO_DOUBLE_ELEVATION')
})

test('normalizeSudo: strict — valid enum in, null for everything else (M4)', () => {
  assert.equal(normalizeSudo('none'), 'none')
  assert.equal(normalizeSudo('auto'), 'auto')
  assert.equal(normalizeSudo('password'), 'password')
  assert.equal(normalizeSudo('AUTO'), 'auto')
  assert.equal(normalizeSudo(undefined), null)
  assert.equal(normalizeSudo(''), null)
  assert.equal(normalizeSudo('inherit-login'), null)
  assert.equal(normalizeSudo('passwordless'), null)
  assert.equal(normalizeSudo('weird'), null)
  assert.deepEqual(SUDO_MODES, ['none', 'auto', 'password'])
})

test('shellQuote: POSIX single-quote escaping', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('plain'), "'plain'")
})

test('protocol commands: wrapped shells carry marker built from halves', () => {
  assert.equal(SUDO_PROBE_COMMAND, 'sudo -n true')
  // the marker is assembled so the literal never appears in the command text
  assert.ok(!SUDO_EXEC_MARKER.includes('__OPS' + 'SSH_EXEC__') || SUDO_EXEC_MARKER === '__OPS' + 'SSH_EXEC__')
  const exec = sudoExecShell('systemctl restart nginx')
  const ask = sudoAskpassShell('systemctl restart nginx')
  assert.ok(exec.startsWith('sudo -n '))
  assert.ok(ask.startsWith("sudo -S -p '' "))
  assert.ok(exec.includes('/bin/sh') && exec.includes('-c'))
  // marker construction present inside the wrapped inner command
  assert.ok(exec.includes('echo ') && exec.includes('>&2'))
  assert.ok(ask.includes('echo ') && ask.includes('>&2'))
  // the literal assembled marker must NOT appear verbatim in the outer command
  assert.ok(!exec.includes(SUDO_EXEC_MARKER), 'marker must be built by inner shell concatenation')
  assert.ok(!ask.includes(SUDO_EXEC_MARKER), 'marker must be built by inner shell concatenation')
  assert.equal(sudoPasswordFrame('s3cret'), 's3cret\n')
})

test('classifySudoPhase: marker is the executed signal, rc is the command\'s own', () => {
  // NOPASSWD + command rc=1 → executed with rc 1 (review item 2: no false retry)
  assert.deepEqual(classifySudoPhase(1, '__OPS' + 'SSH_EXEC__', true), { kind: 'executed' })
  assert.deepEqual(classifySudoPhase(0, '', true), { kind: 'executed' })
  // no marker: sudo refused — rc is sudo's, never trust it as success
  assert.equal(classifySudoPhase(0, '', false).kind, 'failed')
  assert.equal(classifySudoPhase(1, 'sudo: a password is required', false).kind, 'password')
  assert.equal(classifySudoPhase(1, 'sudo: 需要密码', false).kind, 'password')
  assert.equal(classifySudoPhase(1, 'sudo: interactive authentication is required', false).kind, 'password')
  assert.equal(classifySudoPhase(127, 'ash: sudo: not found', false).kind, 'no-sudo')
  assert.equal(classifySudoPhase(127, '', false).kind, 'no-sudo')
  assert.equal(classifySudoPhase(2, 'usage: sudo', false).kind, 'password')
})



test('classifySudoRunError: only sudo-specific failures classify', () => {
  assert.equal(classifySudoRunError('sudo: 1 incorrect password attempt'), 'SUDO_AUTH_FAILED')
  assert.equal(classifySudoRunError('sudo: no password was provided'), 'SUDO_AUTH_FAILED')
  assert.equal(classifySudoRunError('sudo: 认证失败'), 'SUDO_AUTH_FAILED')
  assert.equal(classifySudoRunError('alice is not allowed to execute systemctl'), 'SUDO_POLICY_DENIED')
  assert.equal(classifySudoRunError('alice is not in the sudoers file. This incident will be reported.'), 'SUDO_POLICY_DENIED')
  // ordinary command failures must NOT classify — they pass through as exitCode
  assert.equal(classifySudoRunError('grep: no match'), null)
  assert.equal(classifySudoRunError('cat: /etc/shadow: Permission denied'), null)
  assert.equal(classifySudoRunError(''), null)
})

test('classifySudoRunError: zh locale variants (L2)', () => {
  assert.equal(classifySudoRunError('sudo: 不允许执行该命令'), 'SUDO_POLICY_DENIED')
  assert.equal(classifySudoRunError('sudo: 3 次密码不正确'), null) // unknown phrasing → generic, not misclassified
})

test('every error code has a model-facing hint without secrets', () => {
  for (const code of ['SUDO_TOKEN_WITHOUT_ELEVATE', 'SUDO_DOUBLE_ELEVATION', 'ELEVATION_DISABLED',
    'SUDO_NOT_FOUND', 'SUDO_PASSWORD_REQUIRED', 'SUDO_AUTH_FAILED', 'SUDO_POLICY_DENIED', 'SUDO_FAILED']) {
    assert.equal(typeof SUDO_ERROR_HINTS[code], 'string')
    assert.ok(SUDO_ERROR_HINTS[code].length > 10)
  }
})
