// ops-ssh-manager — Host half entry.
//
// Responsibilities:
//   - register the model tools (ssh_exec / ssh_list_hosts) via ctx.tools
//   - expose a small JSON management API on ctx.webServer (used by the
//     plugin-config card in settings.plugin.item) for the roster and key
//     metadata; private keys / passwords go through the credentials seam,
//     never here
//   - the AGENT only ever sees ssh_exec/ssh_list_hosts; adding hosts, keys, or
//     toggling a review level is human-only through the management page
//     (execution permission vs. configuration permission stay separate).

import { dataDir, loadRoster, saveRoster, writeAudit, auditPath, keyRef, passRef, sudoRef, getSecret, setSecret, unsetSecret } from './store.mjs'
import { derivePublicKey, probeConnection, probeSudoCapability, verifySudoPassword } from './ssh.mjs'
import { validateHost, validateRoster, publicHostView, KEY_ID_RE, ROSTER_VERSION } from './schema.mjs'
import { mountSshTools } from './tool.mjs'
import { auditRecord, auditLine } from './audit.mjs'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'ops-ssh-manager'
export const inject = ['credentials', 'tools', 'webServer']

// Settings namespace: `settings.plugin.item` cards are keyed by settings
// NAMESPACE (see dsh-client-ui-settings-plugins), so registering one is what
// surfaces this plugin in 「设置 → 插件」. dataDir/auditLog stay composition-driven
// for Phase 1; the namespace only makes the card dispatchable.
const SETTINGS_NS = settingsNamespace('ops-ssh-manager')
const Config = z.object({
  dataDir: z.string().default(''),
  auditLog: z.string().default(''),
})

function send(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('invalid JSON body') }
}

function keyMetaOf(id, name, pubkey) {
  return { id: String(id), name: String(name || id), pubkey, createdAt: new Date().toISOString() }
}

export function apply(ctx, config = {}) {
  const credentials = ctx.credentials
  const tools = ctx.tools
  const webServer = ctx.webServer

  const dir = dataDir(config)
  const audit = auditPath(config, dir)

  // Surface the plugin in the Plugins config section (rides the fiber, so it
  // registers nothing when the settings service is not mounted).
  installSettingsSection(ctx, SETTINGS_NS, Config, { dataDir: config.dataDir ?? '', auditLog: config.auditLog ?? '' }, {
    setSource: () => {},
    onChange: () => {},
  })

  async function guardAudit(record) {
    await writeAudit(audit, auditLine(record))
  }

  // ---- tools ----
  ctx.effect(() => mountSshTools(ctx, config), 'ops-ssh-manager: tools')

  // ---- management HTTP API ----
  const register = (path, handler) => ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), 'ops-ssh-manager: ' + path)

  register('/api/ops-ssh/roster', async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
    const roster = await loadRoster(dir)
    // M3: key metadata beyond id/name is not needed by the card — don't hand
    // out pubkeys on the roster endpoint (export/import endpoints stay as is).
    send(res, 200, {
      ok: true,
      hosts: roster.hosts,
      keys: (roster.keys || []).map((k) => ({ id: k.id, name: k.name })),
    })
  })

  register('/api/ops-ssh/hosts', async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readJson(req)
        const r = validateHost(body)
        if (!r.ok) return send(res, 400, { ok: false, error: r.error })
        // L4: validate sudoPassword/sudo-mode consistency BEFORE saving so a
        // 400 can never leave a half-committed roster behind.
        if (r.host.sudo !== 'password' && typeof body.sudoPassword === 'string' && body.sudoPassword !== '') {
          return send(res, 400, { ok: false, error: 'sudoPassword 仅在 sudo=password 时可填（先在 sudo 模式里选择「需要密码」）' })
        }
        const roster = await loadRoster(dir)
        const idx = roster.hosts.findIndex((h) => h.code === r.host.code)
        if (idx >= 0) roster.hosts[idx] = r.host
        else roster.hosts.push(r.host)
        await saveRoster(dir, roster)
        if (r.host.authType === 'password' && typeof body.password === 'string' && body.password !== '') {
          await setSecret(credentials, passRef(r.host.code), body.password)
        }
        // sudo (chain B): only mode 'password' carries a secret; empty string on
        // a 'password' host clears it; other modes never touch the ref (the
        // mode/secret mismatch case was already rejected above, pre-save).
        if (r.host.sudo === 'password') {
          if (typeof body.sudoPassword === 'string' && body.sudoPassword !== '') {
            await setSecret(credentials, sudoRef(r.host.code), body.sudoPassword)
          } else if (body.sudoPassword === '') {
            await unsetSecret(credentials, sudoRef(r.host.code))
          }
        }
        await guardAudit(auditRecord({ ts: new Date().toISOString(), code: r.host.code, tool: 'mgmt:hosts', args: { host: r.host }, allowed: true }))
        return send(res, 200, { ok: true, hosts: (await loadRoster(dir)).hosts })
      }
      if (req.method === 'DELETE') {
        const code = String((req.url || '').split('?')[1] || '').split('&').map((kv) => kv.split('=')).find((kv) => kv[0] === 'code')?.slice(1).join('=') || ''
        if (!code) return send(res, 400, { ok: false, error: 'missing code' })
        const roster = await loadRoster(dir)
        const host = roster.hosts.find((h) => h.code === code)
        if (host && host.authType === 'password') await unsetSecret(credentials, passRef(code))
        if (host) await unsetSecret(credentials, sudoRef(code))
        roster.hosts = roster.hosts.filter((h) => h.code !== code)
        await saveRoster(dir, roster)
        return send(res, 200, { ok: true, hosts: (await loadRoster(dir)).hosts })
      }
      send(res, 405, { ok: false, error: 'method not allowed' })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  register('/api/ops-ssh/keys', async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readJson(req)
        // id is auto-derived from the human-readable name when absent; the user
        // never has to invent an opaque id.
        let id = (typeof body.id === 'string' && body.id) ? body.id : ''
        if (!id && typeof body.name === 'string') id = body.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
        if (!id) id = 'key' + Date.now().toString(36)
        id = id.trim()
        if (!KEY_ID_RE.test(id)) return send(res, 400, { ok: false, error: 'invalid key id（仅限字母/数字与 _ -，长度 1-64）' })
        const name = String(body.name || id).trim()
        const pub = derivePublicKey(body.privateKey, body.passphrase)
        if (!pub.ok) return send(res, 400, { ok: false, error: pub.error })
        await setSecret(credentials, keyRef(id), body.privateKey)
        const roster = await loadRoster(dir)
        const idx = roster.keys.findIndex((k) => k.id === id)
        const meta = keyMetaOf(id, name, pub.pubkey)
        if (idx >= 0) roster.keys[idx] = meta
        else roster.keys.push(meta)
        await saveRoster(dir, roster)
        return send(res, 200, { ok: true, keys: (await loadRoster(dir)).keys })
      }
      if (req.method === 'DELETE') {
        const id = decodeURIComponent(String((req.url || '').split('?')[1] || '').split('&').map((kv) => kv.split('=')).find((kv) => kv[0] === 'id')?.slice(1).join('=') || '')
        if (!id) return send(res, 400, { ok: false, error: 'missing id' })
        const roster = await loadRoster(dir)
        if (roster.hosts.some((h) => h.authType === 'key' && h.keyId === id)) {
          return send(res, 409, { ok: false, error: '该密钥仍被主机引用，先解除引用再删除' })
        }
        await unsetSecret(credentials, keyRef(id))
        roster.keys = roster.keys.filter((k) => k.id !== id)
        await saveRoster(dir, roster)
        return send(res, 200, { ok: true, keys: (await loadRoster(dir)).keys })
      }
      send(res, 405, { ok: false, error: 'method not allowed' })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  register('/api/ops-ssh/test', async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJson(req)
      const authType = body.authType === 'password' ? 'password' : 'key'
      let privateKey, password
      if (authType === 'password') {
        password = (typeof body.password === 'string' && body.password !== '')
          ? body.password
          : await getSecret(credentials, passRef(body.code || 'probe'))
      } else privateKey = await getSecret(credentials, keyRef(body.keyId))
      if (authType === 'key' && !privateKey) return send(res, 400, { ok: false, error: '该密钥未登记/私钥缺失' })
      if (authType === 'password' && !password) return send(res, 400, { ok: false, error: '密码缺失' })
      const r = await probeConnection({
        host: body.host, port: body.port, username: body.username,
        privateKey, password, timeoutMs: 15000,
      })
      send(res, r.ok ? 200 : 502, r)
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  // sudo capability probe: `sudo -n true` — never prompts, never hangs.
  register('/api/ops-ssh/test-sudo', async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJson(req)
      const roster = await loadRoster(dir)
      const host = roster.hosts.find((h) => h.code === body.code)
      if (!host) return send(res, 404, { ok: false, error: 'unknown host code: ' + body.code })
      if (host.sudo === 'none') return send(res, 400, { ok: false, error: '该主机 sudo 模式为 none（未启用提权）' })
      const auth = host.authType === 'password'
        ? { password: await getSecret(credentials, passRef(host.code)) }
        : { privateKey: await getSecret(credentials, keyRef(host.keyId)) }
      // H2: a missing LOGIN credential is a 400, not a confusing probe failure.
      if (host.authType === 'password' && !auth.password) {
        return send(res, 400, { ok: false, error: '登录密码未登记，无法测试 sudo' })
      }
      if (host.authType === 'key' && !auth.privateKey) {
        return send(res, 400, { ok: false, error: '引用的私钥缺失/未登记，无法测试 sudo' })
      }
      const r = await probeSudoCapability({
        host: host.host, port: host.port, username: host.username,
        ...auth, expectedFingerprint: host.fingerprint, timeoutMs: 15000,
      })
      const capMsg = r.capability === 'passwordless' ? null
        : r.capability === 'password' ? '该机 sudo 需要密码：请把 sudo 方式切换为「密码」并填写'
        : r.capability === 'no-sudo' ? '该机未安装 sudo'
        : ((r.stderr || '').trim().slice(0, 120) || '探测失败')
      send(res, 200, { ok: r.ok, capability: r.capability, error: capMsg || undefined })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  // sudo password verify: `sudo -S -v` with the given or stored password.
  register('/api/ops-ssh/verify-sudo-password', async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJson(req)
      const roster = await loadRoster(dir)
      const host = roster.hosts.find((h) => h.code === body.code)
      if (!host) return send(res, 404, { ok: false, error: 'unknown host code: ' + body.code })
      // The form may carry a freshly typed password whose mode switch is not
      // saved yet (first-verify-fails trap): verify what the form shows. A
      // stored password is only consulted when the request brings none.
      const sudoPassword = (typeof body.sudoPassword === 'string' && body.sudoPassword !== '')
        ? body.sudoPassword
        : await getSecret(credentials, sudoRef(host.code))
      if (!sudoPassword) return send(res, 400, { ok: false, error: 'sudo 密码未登记：请填入密码后先保存再验证' })
      const auth = host.authType === 'password'
        ? { password: await getSecret(credentials, passRef(host.code)) }
        : { privateKey: await getSecret(credentials, keyRef(host.keyId)) }
      const r = await verifySudoPassword({
        host: host.host, port: host.port, username: host.username,
        ...auth, expectedFingerprint: host.fingerprint, sudoPassword, timeoutMs: 15000,
      })
      if (r.ok) return send(res, 200, { ok: true })
      send(res, 200, {
        ok: false,
        error: r.sudoErrorCode === 'SUDO_AUTH_FAILED' ? 'sudo 密码不正确（单次尝试未重试）'
          : r.sudoErrorCode === 'SUDO_POLICY_DENIED' ? '远端 sudoers 拒绝验证命令'
          : '验证失败：' + ((r.stderr || r.error || '').trim().slice(0, 120) || '未知原因'),
      })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  register('/api/ops-ssh/export', async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
    const roster = await loadRoster(dir)
    send(res, 200, { ok: true, roster })
  })

  register('/api/ops-ssh/import', async (req, res) => {
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJson(req)
      const roster = await loadRoster(dir)
      // Import merges: hosts replaced, keys METADATA merged (private keys live
      // in credentials and are intentionally NOT part of export/import).
      const incoming = body.roster || body
      const hosts = Array.isArray(incoming.hosts) ? incoming.hosts : []
      const validHosts = []
      for (const h of hosts) {
        const r = validateHost(h)
        if (!r.ok) return send(res, 400, { ok: false, error: 'invalid host: ' + r.error })
        validHosts.push(r.host)
      }
      const incomingKeys = Array.isArray(incoming.keys) ? incoming.keys : []
      const keyMap = new Map(roster.keys.map((k) => [k.id, k]))
      for (const k of incomingKeys) {
        if (!k || typeof k !== 'object' || Array.isArray(k)) continue
        const id = String(k.id || '').trim()
        if (!KEY_ID_RE.test(id)) continue // skip malformed ids, don't pollute the roster
        keyMap.set(id, {
          id,
          name: String(k.name || id),
          pubkey: typeof k.pubkey === 'string' ? k.pubkey : '',
          createdAt: k.createdAt || new Date().toISOString(),
        })
      }
      const keys = Array.from(keyMap.values())
      // Whole-roster validation (review H1/M2): version must be ROSTER_VERSION
      // and the merged shape must pass v2 validation before anything is saved.
      const check = validateRoster({ version: ROSTER_VERSION, hosts: validHosts, keys })
      if (!check.ok) return send(res, 400, { ok: false, error: check.error })
      await saveRoster(dir, check.roster)
      send(res, 200, { ok: true, hosts: check.roster.hosts, keys: check.roster.keys })
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })
}