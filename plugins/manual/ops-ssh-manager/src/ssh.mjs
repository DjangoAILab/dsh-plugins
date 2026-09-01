// SSH transport over ssh2. Imports the `ssh2` CommonJS package via default
// import and destructures, to avoid named-import interop edge cases.

import ssh2 from 'ssh2'
import { isDestructive } from './policy.mjs'
import {
  SUDO_PROBE_COMMAND, SUDO_EXEC_MARKER, sudoExecShell, sudoAskpassShell,
  sudoPasswordFrame, classifySudoPhase, classifySudoRunError,
} from './sudo.mjs'

const { Client, utils } = ssh2

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function withConnection(opts, onReady) {
  return new Promise((resolve) => {
    const conn = new Client()
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000
    let settled = false
    let observedFingerprint = null
    const finish = (result) => {
      if (settled) return
      settled = true
      try { conn.end() } catch { /* ignore */ }
      resolve(result)
    }
    const timer = setTimeout(() => { conn.destroy(); finish({ ok: false, error: 'SSH connection timed out', timedOut: true }) }, timeoutMs)

    conn.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: String(err && err.message ? err.message : err) }) })

    const connectOptions = {
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      readyTimeout: timeoutMs,
      hostHash: 'sha256',
      hostVerifier(keyHash) {
        // keyHash is the HEX SHA256 of the host key (hex, not base64).
        // Pin mode: strict compare. Probe mode (no pin): accept and capture.
        observedFingerprint = keyHash
        return opts.expectedFingerprint ? keyHash === opts.expectedFingerprint : true
      },
    }
    if (opts.privateKey) connectOptions.privateKey = opts.privateKey
    if (opts.passphrase) connectOptions.passphrase = opts.passphrase
    if (opts.password) connectOptions.password = opts.password

    conn.on('ready', () => onReady(conn, { finish, observedFingerprint, clearTimer: () => clearTimeout(timer) }))
    conn.connect(connectOptions)
  })
}

/**
 * Probe a connection WITHOUT a pinned fingerprint (TOFU capture): connect with
 * any host key, record its SHA256 handshake fingerprint, run a lightweight
 * read-only command, and return the fingerprint so an operator can pin it.
 */
export function probeConnection(opts) {
  return withConnection(opts, (conn, { finish, observedFingerprint, clearTimer }) => {
    conn.exec('uptime', (err, stream) => {
      if (err) { clearTimer(); finish({ ok: false, error: String(err.message) }); return }
      let out = ''
      stream.on('data', (d) => { out += d })
      stream.stderr.on('data', (d) => { out += d })
      stream.on('close', () => { clearTimer(); finish({ ok: true, fingerprint: observedFingerprint, output: out.trim() }) })
    })
  })
}

/**
 * Execute one command. `expectedFingerprint` is REQUIRED (fail-closed TOFU):
 * a host whose fingerprint was never pinned in the management page is refused.
 *
 * When `opts.elevate` is true, a two-phase sudo protocol runs on the SAME
 * connection (DESIGN.md §11.2, exit-code driven — stderr text is locale
 * dependent and never decides a branch):
 *   1. `sudo -n <cmd>` — passwordless (NOPASSWD / cached ticket) → done, the
 *      sudo password never leaves this process. rc=127 → no sudo on the box.
 *   2. otherwise (sudo refused BEFORE running anything, so re-running is safe)
 *      `sudo -S -p '' <cmd>` with ONE password line written to the channel
 *      stdin, then EOF. sudo consumes the line itself; the command inherits
 *      EOF, so the password can never leak into the command's stdout.
 * Requires opts.sudoPassword when phase 2 is reached (undefined → the caller
 * has already mapped that to SUDO_PASSWORD_REQUIRED).
 */
export function execCommand(opts) {
  if (!opts.expectedFingerprint) {
    return Promise.resolve({ ok: false, error: '该主机指纹尚未固定（TOFU）；请先在管理页测试连接并固定指纹', needsPin: true })
  }
  const command = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ${opts.command}` : opts.command
  if (!opts.elevate) {
    return withConnection(opts, (conn, { finish, clearTimer }) => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimer(); finish({ ok: false, error: String(err.message) }); return }
        let stdout = ''
        let stderr = ''
        stream.on('data', (d) => { stdout += d })
        stream.stderr.on('data', (d) => { stderr += d })
        stream.on('close', (code) => { clearTimer(); finish({ ok: true, exitCode: code, stdout, stderr }) })
      })
    })
  }
  return withConnection(opts, (conn, { finish, clearTimer }) => {
    // ---- phase 1: passwordless probe-and-run (`sudo -n` + exec marker) ----
    conn.exec(sudoExecShell(command), (err, stream) => {
      if (err) { clearTimer(); finish({ ok: false, error: String(err.message) }); return }
      let p1out = ''
      let p1err = ''
      stream.on('data', (d) => { p1out += d })
      stream.stderr.on('data', (d) => { p1err += d })
      stream.on('error', (e) => { clearTimer(); finish({ ok: false, error: 'sudo channel error: ' + String(e && e.message ? e.message : e) }) })
      stream.on('close', (code1) => {
        // Marker distinguishes "NOPASSWD, command executed (rc = command's own
        // rc, even 1)" from "sudo refused (nothing ran)" — exit code alone
        // cannot (review item 2).
        const probe = classifySudoPhase(code1, p1err, p1err.includes(SUDO_EXEC_MARKER))
        if (probe.kind === 'executed') {
          clearTimer()
          return finish({ ok: true, exitCode: code1, stdout: p1out, stderr: p1err, elevatePath: 'passwordless' })
        }
        if (probe.kind === 'no-sudo') {
          clearTimer()
          return finish({ ok: false, error: 'sudo', sudoErrorCode: 'SUDO_NOT_FOUND', stderr: p1err })
        }
        if (probe.kind === 'failed') {
          clearTimer()
          return finish({ ok: false, error: 'sudo', sudoErrorCode: 'SUDO_FAILED', stderr: (p1err || `exit ${code1}`) })
        }
        // probe.kind === 'password' (no marker, rc≠0 → nothing ran, safe to rerun)
        if (!opts.sudoPassword) {
          clearTimer()
          return finish({ ok: false, error: 'sudo', sudoErrorCode: 'SUDO_PASSWORD_REQUIRED', stderr: p1err })
        }
        // ---- phase 2: `sudo -S -p '' sh -c <wrapped>` + one password line + EOF ----
        // C1 fix: ssh2 exec Channels NEVER emit 'ready' (only Client/SFTP do) —
        // write immediately in the exec callback; the channel buffers stdin
        // until sudo reads it. C2 fix: the exec marker separates "sudo auth
        // passed, command ran (rc = command's own rc)" from "sudo refused
        // (sh never exec'd, rc is sudo's)" without trusting sudo exit codes.
        conn.exec(sudoAskpassShell(command), (err2, stream2) => {
          if (err2) { clearTimer(); finish({ ok: false, error: String(err2.message) }); return }
          let stdout = ''
          let stderr = ''
          let wrote = false
          let closed = false
          stream2.on('data', (d) => { stdout += d })
          stream2.stderr.on('data', (d) => { stderr += d })
          stream2.on('error', (e) => { clearTimer(); finish({ ok: false, error: 'sudo channel error: ' + String(e && e.message ? e.message : e) }) })
          try {
            stream2.write(sudoPasswordFrame(opts.sudoPassword))
            stream2.end()
            wrote = true
          } catch (e) {
            closed = true
            clearTimer(); finish({ ok: false, error: 'sudo stdin write failed: ' + String(e && e.message ? e.message : e) })
          }
          stream2.on('close', (code2) => {
            if (closed) return
            closed = true
            clearTimer()
            if (!wrote) return finish({ ok: false, error: 'sudo', sudoErrorCode: 'SUDO_FAILED', stderr })
            const phase = classifySudoPhase(code2, stderr, stderr.includes(SUDO_EXEC_MARKER))
            if (phase.kind === 'executed') {
              // Command genuinely ran; its own exit code is the result.
              return finish({ ok: true, exitCode: code2, stdout, stderr, elevatePath: 'password' })
            }
            // No marker → sudo refused (sh never exec'd). Never report success.
            const sudoErr = classifySudoRunError(stderr) || 'SUDO_FAILED'
            finish({ ok: false, error: 'sudo', sudoErrorCode: sudoErr, stderr })
          })
        })
      })
    })
  })
}

/**
 * Probe the sudo capability WITHOUT running a user command (`sudo -n true`).
 * Used by the management page「测试提权」. Never prompts, never hangs.
 */
export function probeSudoCapability(opts) {
  return withConnection(opts, (conn, { finish, clearTimer }) => {
    conn.exec(SUDO_PROBE_COMMAND, (err, stream) => {
      if (err) { clearTimer(); finish({ ok: false, error: String(err.message) }); return }
      let stderr = ''
      stream.on('data', () => {})
      stream.stderr.on('data', (d) => { stderr += d })
      stream.on('close', (code) => {
        clearTimer()
        // Bare `sudo -n true` has no marker wrapper: rc=0 IS the passwordless
        // signal here; the rest branches via classifySudoPhase (no marker).
        const capability = code === 0
          ? 'passwordless'
          : classifySudoPhase(code, stderr, false).kind
        finish({ ok: capability === 'passwordless', capability, stderr: stderr.trim() })
      })
    })
  })
}

/**
 * Verify a stored sudo password once (`sudo -S -p '' -v` + one line + EOF).
 * Used by the management page「测试 sudo 密码」. Single attempt, no retry.
 */
export function verifySudoPassword(opts) {
  return withConnection(opts, (conn, { finish, clearTimer }) => {
    conn.exec("sudo -S -p '' -v", (err, stream) => {
      if (err) { clearTimer(); finish({ ok: false, error: String(err.message) }); return }
      let stderr = ''
      let closed = false
      stream.on('data', () => {})
      stream.stderr.on('data', (d) => { stderr += d })
      stream.on('error', (e) => { clearTimer(); finish({ ok: false, error: 'sudo channel error: ' + String(e && e.message ? e.message : e) }) })
      try {
        // ssh2 exec channels never emit 'ready' — write immediately (buffered).
        stream.write(sudoPasswordFrame(opts.sudoPassword))
        stream.end()
      } catch (e) {
        closed = true
        clearTimer(); finish({ ok: false, error: 'sudo stdin write failed: ' + String(e && e.message ? e.message : e) })
      }
      stream.on('close', (code) => {
        if (closed) return
        closed = true
        clearTimer()
        if (code === 0) return finish({ ok: true })
        const sudoErr = classifySudoRunError(stderr)
        finish({ ok: false, sudoErrorCode: sudoErr || 'SUDO_FAILED', stderr: stderr.trim() })
      })
    })
  })
}

/**
 * Derive the OpenSSH public key from an imported private key (PEM or OpenSSH
 * format). Returns { ok, pubkey | error }. Used for the key list + "copy public key".
 */
export function derivePublicKey(pem, passphrase) {
  try {
    if (typeof pem !== 'string' || pem.trim() === '') return { ok: false, error: 'empty key material' }
    let parsed = utils.parseKey(pem, passphrase || undefined)
    if (Array.isArray(parsed)) parsed = parsed[0]
    if (!parsed || typeof parsed.getPublicSSH !== 'function') return { ok: false, error: 'unable to derive public key' }
    // ssh2's getPublicSSH() returns a Buffer (raw key body) — not a string in 1.x.
    const raw = parsed.getPublicSSH()
    const body = typeof raw === 'string' ? raw : raw.toString('base64')
    const pubkey = ((parsed.type ? parsed.type + ' ' : '') + body).trim()
    return { ok: true, pubkey }
  } catch (e) {
    return { ok: false, error: 'invalid key: ' + String(e && e.message ? e.message : e) }
  }
}

export { isDestructive }