// ops-ssh-manager — Client half: plugin-config card (settings.plugin.item).
// Reuses shipped DSH primitives (Modal / Button / Input); renders a collapsible
// "settings card" shell matching the other Plugins-section cards.

window.__ModuleLoader__.load({
  id: "ops-ssh-manager",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require("react")
    const { createElement: h, useState, useEffect, Fragment } = react

    // ---- resolve shipped UI primitives ----
    function realGlobal() {
      try { if (typeof window !== "undefined" && window) return window } catch (e) { /* ignore */ }
      try { if (typeof globalThis !== "undefined" && globalThis) return globalThis } catch (e) { /* ignore */ }
      return null
    }
    function pickNamed(mod, key) {
      if (!mod) return null
      if (typeof mod[key] === "function") return mod[key]
      if (mod.default && typeof mod.default[key] === "function") return mod.default[key]
      return null
    }
    const compCache = {}
    function resolveComponent(require, spec, key) {
      const ck = spec + "#" + key
      if (compCache[ck] !== undefined) return compCache[ck]
      let hit = null
      try { hit = pickNamed(require(spec), key) } catch (e) { hit = null }
      if (!hit) {
        const g = realGlobal()
        const ms = g && g.__DSH_MODULES__
        if (ms) {
          const tries = []
          try { if (ms.seed && typeof ms.seed.get === "function") tries.push(ms.seed.get(spec)) } catch (e) { /* ignore */ }
          try { if (ms.statics && typeof ms.statics.get === "function") tries.push(ms.statics.get(spec)) } catch (e) { /* ignore */ }
          for (const t of tries) { const c = pickNamed(t, key); if (c) { hit = c; break } }
        }
      }
      compCache[ck] = hit
      return hit
    }
    const PRIM = "@deepseek-ai/dsh-client-ui-primitives"
    const Modal = resolveComponent(require, PRIM, "Modal") || null
    const Button = resolveComponent(require, PRIM, "Button") || null
    const Input = resolveComponent(require, PRIM, "Input") || null

    // ---- HTTP helpers ----
    async function api(path, opts) {
      const res = await fetch(path, opts)
      const body = await res.json().catch(() => ({ ok: false, error: "non-JSON response" }))
      if (!res.ok || body.ok === false) throw new Error(body.error || ("HTTP " + res.status))
      return body
    }
    function jsonDownload(filename, obj) {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    }

    // ---- small building blocks ----
    function Btn({ variant, size, onClick, type, children }) {
      if (Button) return h(Button, { variant, size, type: type || "button", onClick }, children)
      return h("button", { type: type || "button", onClick, className: "oss-btn-fb" }, children)
    }
    function TextInput({ label, value, onChange, type, placeholder }) {
      const v = value == null ? "" : value
      const onCh = (e) => onChange(e.target.value)
      if (Input) {
        return h("div", { className: "oss-field" },
          h("label", { className: "oss-label" }, label),
          h(Input, { value: v, onChange: onCh, type: type || "text", placeholder }))
      }
      return h("div", { className: "oss-field" },
        h("label", { className: "oss-label" }, label),
        h("input", { className: "oss-in-fb", value: v, onChange: onCh, type: type || "text", placeholder }))
    }
    function Select({ label, value, onChange, options, hint }) {
      return h("div", { className: "oss-field" },
        h("label", { className: "oss-label" }, label),
        h("select", { className: "oss-select", value: value, onChange: (e) => onChange(e.target.value) },
          options.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
        hint ? h("div", { className: "oss-desc" }, hint) : null
      )
    }

    function Chevron(open) {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", style: { color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))", flex: "none", transition: "transform .16s", transform: open ? "rotate(180deg)" : "none" } },
        h("path", { d: "M4 6l4 4 4-4", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))
    }

    const CSS = [
      ".oss-card { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35)); border-radius:12px; background:var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05)); transition:border-color .16s, background .16s; }",
      ".oss-card.open { background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10)); }",
      ".oss-cardhead { display:flex; align-items:center; gap:12px; width:100%; box-sizing:border-box; padding:14px 16px; border:0; border-radius:12px; background:none; cursor:pointer; text-align:left; appearance:none; font:inherit; color:inherit; }",
      ".oss-head-text { flex:1; display:flex; flex-direction:column; gap:2px; min-width:0; }",
      ".oss-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); }",
      ".oss-desc { font-size:13px; line-height:1.5; color:var(--dsw-alias-label-tertiary); word-break:break-word; }",
      ".oss-body { display:flex; flex-direction:column; gap:14px; padding:0 16px 8px; min-width:0; }",
      ".oss-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
      ".oss-ghostbtn { display:inline-flex; align-items:center; font:inherit; font-size:13px; line-height:1.5; padding:5px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:none; color:var(--dsw-alias-label-secondary, inherit); cursor:pointer; }",
      ".oss-hint { font-size:12px; color:var(--dsw-alias-label-tertiary); }",
      ".oss-sec { display:flex; flex-direction:column; gap:6px; min-width:0; }",
      ".oss-sec-label { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }",
      ".oss-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; min-width:0; }",
      ".oss-row-main { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; font-size:13px; color:var(--dsw-alias-label-primary); }",
      ".oss-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)); word-break:break-all; }",
      ".oss-sub { font-size:12px; color:var(--dsw-alias-label-tertiary); }",
      ".oss-badge { font-size:11px; padding:1px 8px; border-radius:999px; color:#7fc27f; background:rgba(127,194,127,.12); white-space:nowrap; }",
      ".oss-badge-strict { font-size:11px; padding:1px 8px; border-radius:999px; color:#ff9b9b; background:rgba(255,120,120,.14); white-space:nowrap; }",
      ".oss-warn { font-size:12px; color:#e5a34e; }",
      ".oss-row-actions { display:flex; gap:6px; flex:none; }",
      ".oss-empty { font-size:12px; color:var(--dsw-alias-label-tertiary); }",
      ".oss-actions { display:flex; gap:8px; justify-content:flex-end; padding-top:4px; flex-wrap:wrap; }",
      ".oss-form { display:flex; flex-direction:column; gap:10px; }",
      ".oss-grid { display:grid; grid-template-columns:1fr; gap:10px; }",
      ".oss-field { display:flex; flex-direction:column; gap:4px; min-width:0; }",
      ".oss-label { font-size:12px; color:var(--dsw-alias-label-tertiary); }",
      ".oss-select { box-sizing:border-box; width:100%; font-family:inherit; font-size:13px; padding:6px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-l2, transparent); color:var(--dsw-alias-label-primary); }",
      ".oss-textarea { box-sizing:border-box; width:100%; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; min-height:120px; padding:8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-l2, transparent); color:var(--dsw-alias-label-primary); resize:vertical; }",
      ".oss-msg { font-size:12px; color:var(--dsw-alias-label-tertiary); word-break:break-all; }",
      ".oss-msg.err { color:#ff9b9b; }",
      ".oss-btn-fb, .oss-in-fb { font-family:inherit; font-size:13px; }",
    ].join("\n")

    // ---- Host add/edit modal ----
    function HostModal({ initial, keys, onClose, onSaved }) {
      return Modal
        ? h(Modal, { open: true, onClose, title: initial ? ("编辑主机 " + initial.code) : "新增主机" },
            h(HostForm, { initial, keys, onClose, onSaved }))
        : h("div", { className: "oss-form", style: { padding: 8 } }, h(HostForm, { initial, keys, onClose, onSaved }))
    }

    function HostForm({ initial, keys, onClose, onSaved }) {
      const [form, setForm] = useState(() => initial
        ? { ...initial, port: String(initial.port || 22), sudoEnabled: initial.sudo !== "none", sudoPassword: "" }
        : { code: "", alias: "", host: "", port: "22", username: "", authType: "key", keyId: (keys && keys.length === 1 ? keys[0].id : ""), review: "normal", defaultDir: "", fingerprint: "", password: "", sudo: "auto", sudoEnabled: true, sudoPassword: "" })
      const [busy, setBusy] = useState("")
      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
      const isPassword = form.authType === "password"
      const keyOptions = (keys || []).map((k) => ({ value: k.id, label: k.name && k.name !== k.id ? (k.name + "（" + k.id + "）") : k.id }))

      async function test() {
        setBusy("测试中…")
        try {
          const r = await api("/api/ops-ssh/test", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: form.code, host: form.host, port: form.port, username: form.username, authType: form.authType, keyId: form.keyId, password: form.password }),
          })
          if (r.ok && r.fingerprint) {
            set("fingerprint")(r.fingerprint)
            setBusy("连接成功，已固定指纹（" + r.fingerprint + "）。建议先「保存」再测 sudo（测试 sudo 用的是已登记的登录凭据）。")
          }
          else setBusy("测试失败：" + (r.error || "unknown"))
        } catch (e) { setBusy("测试失败：" + e.message) }
      }

      // Post-save helper: probe sudo capability against the REGISTERED host.
      async function testSudo() {
        if (!form.fingerprint) { setBusy("请先保存主机（固定指纹）后再验证"); return }
        if (form.sudo === "password") { setBusy("当前是密码模式，请使用「验证 sudo 密码」"); return }
        setBusy("验证免密 sudo 中…")
        try {
          const r = await api("/api/ops-ssh/test-sudo", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: form.code }),
          })
          if (r.ok) setBusy("✅ 免密 sudo 可用")
          else setBusy("❌ " + (r.error || "该机 sudo 需要密码：请切换为「密码」方式"))
        } catch (e) { setBusy("❌ " + (e.message || "验证失败")) }
      }

      // Verify the sudo password exactly as typed in the form (no need to save
      // first); server falls back to the stored one when the field is empty.
      async function verifySudo() {
        if (!form.fingerprint) { setBusy("请先保存主机（固定指纹）后再验证"); return }
        if (form.sudo !== "password") { setBusy("请先把 sudo 方式切换为「密码」"); return }
        setBusy("验证 sudo 密码中…")
        try {
          const r = await api("/api/ops-ssh/verify-sudo-password", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: form.code, sudoPassword: form.sudoPassword || undefined }),
          })
          setBusy(r.ok ? "✅ sudo 密码验证通过" : "❌ " + (r.error || "验证失败"))
        } catch (e) { setBusy("❌ " + (e.message || "验证失败")) }
      }

      async function save() {
        setBusy("保存中…")
        try {
          const sudoMode = form.sudoEnabled ? (form.sudo === "password" ? "password" : "auto") : "none"
          if (form.sudoEnabled && sudoMode === "password" && !(form.sudoPassword || "").length && !initial) {
            setBusy("请先填写 sudo 密码再保存"); return
          }
          const payload = {
            code: form.code, alias: form.alias, host: form.host, port: form.port, username: form.username,
            authType: form.authType, keyId: form.keyId, review: form.review, defaultDir: form.defaultDir,
            fingerprint: form.fingerprint, password: form.password,
            sudo: sudoMode,
            sudoPassword: sudoMode === "password" ? form.sudoPassword : "",
          }
          await api("/api/ops-ssh/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          onSaved()
        } catch (e) { setBusy("保存失败：" + e.message) }
      }

      return h("form", {
        className: "oss-form",
        onSubmit: (e) => { e.preventDefault(); save() },
      },
        h("div", { className: "oss-grid" },
          TextInput({ label: "代号 code *", value: form.code, onChange: set("code"), placeholder: "prod-01" }),
          TextInput({ label: "备注 alias", value: form.alias, onChange: set("alias"), placeholder: "生产 1 号" }),
          TextInput({ label: "地址 host *", value: form.host, onChange: set("host"), placeholder: "1.2.3.4" }),
          TextInput({ label: "端口 port", value: form.port, onChange: set("port"), type: "number" }),
          TextInput({ label: "用户 username *", value: form.username, onChange: set("username"), placeholder: "root" }),
          Select({ label: "认证方式", value: form.authType, onChange: set("authType"), options: [{ value: "key", label: "SSH 私钥" }, { value: "password", label: "密码" }] }),
        ),
        isPassword
          ? TextInput({ label: "密码（仅存 credentials，界面不回显）", value: form.password, onChange: set("password"), type: "password" })
          : Select({
              label: "SSH 密钥（从已导入的私钥里选）", value: form.keyId, onChange: set("keyId"),
              options: keyOptions.length > 0
                ? [{ value: "", label: "—— 请选择密钥 ——" }, ...keyOptions]
                : [{ value: "", label: "（暂无密钥，请先到「SSH 密钥」区导入私钥）" }],
              hint: keyOptions.length === 0 ? "还没有可用的 SSH 密钥：先保存其它主机，或关闭本表单、到「SSH 密钥」区点「导入私钥」。" : null,
            }),
        h("div", { className: "oss-grid" },
          Select({ label: "审查等级", value: form.review, onChange: set("review"), options: [{ value: "normal", label: "普通（不审批）" }, { value: "strict", label: "严格（逐命令审批）" }] }),
          TextInput({ label: "默认目录（可选）", value: form.defaultDir, onChange: set("defaultDir"), placeholder: "/srv/app" }),
        ),
        h("div", { className: "oss-sec", style: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 10 } },
          h("div", { className: "oss-sec-label" }, "Sudo 提权"),
          h("label", { className: "oss-row", style: { cursor: "pointer" } },
            h("span", { className: "oss-row-main" },
              h("input", { type: "checkbox", checked: form.sudoEnabled, onChange: (e) => set("sudoEnabled")(e.target.checked) }),
              h("span", null, "启用提权")
            )
          ),
          form.sudoEnabled ? h("div", { className: "oss-grid" },
            Select({
              label: "sudo 方式", value: form.sudo === "password" ? "password" : "auto", onChange: set("sudo"),
              options: [
                { value: "auto", label: "免密（NOPASSWD）" },
                { value: "password", label: "密码" },
              ],
            }),
            form.sudo === "password"
              ? TextInput({ label: "sudo 密码", value: form.sudoPassword, onChange: set("sudoPassword"), type: "password" })
              : null,
          ) : h("div", { className: "oss-sub" }, "未启用：提权请求会被直接拒绝。未安装 sudo 的机器选这个。"),
          form.sudoEnabled ? h("div", { className: "oss-row-actions" },
            h(Btn, { variant: "ghost", size: "sm", onClick: testSudo }, "验证免密 sudo"),
            form.sudo === "password" ? h(Btn, { variant: "ghost", size: "sm", onClick: verifySudo }, "验证 sudo 密码") : null
          ) : null
        ),
        h("div", { className: "oss-hint" }, "保存后首次连接会固定主机指纹（TOFU）；指纹无需手工填写。「测试 sudo / 验证密码」用的是已保存的登记信息，请先保存。"),
        busy ? h("div", { className: "oss-msg" + (/失败/.test(busy) ? " err" : "") }, busy) : null,
        h("div", { className: "oss-actions" },
          h(Btn, { variant: "primary", size: "sm", type: "submit" }, "保存"),
          h(Btn, { variant: "outline", size: "sm", onClick: test }, "测试连接"),
          h(Btn, { variant: "ghost", size: "sm", onClick: onClose }, "取消")
        )
      )
    }

    // ---- Key import modal ----
    function KeyModal({ onClose, onSaved }) {
      return Modal
        ? h(Modal, { open: true, onClose, title: "导入私钥" }, h(KeyForm, { onClose, onSaved }))
        : h("div", { className: "oss-form", style: { padding: 8 } }, h(KeyForm, { onClose, onSaved }))
    }
    function KeyForm({ onClose, onSaved }) {
      const [form, setForm] = useState({ name: "", privateKey: "" })
      const [busy, setBusy] = useState("")
      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
      async function save() {
        setBusy("导入中…")
        try {
          await api("/api/ops-ssh/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) })
          onSaved()
        } catch (e) { setBusy("导入失败：" + e.message) }
      }
      return h("form", { className: "oss-form", onSubmit: (e) => { e.preventDefault(); save() } },
        TextInput({ label: "备注（给这把密钥起个名，如「生产私钥」）", value: form.name, onChange: set("name"), placeholder: "生产私钥" }),
        h("div", { className: "oss-field" },
          h("label", { className: "oss-label" }, "私钥内容（PEM / OpenSSH，暂不支持带 passphrase）"),
          h("textarea", { className: "oss-textarea", value: form.privateKey, onChange: (e) => set("privateKey")(e.target.value) }),
        ),
        busy ? h("div", { className: "oss-msg" + (/失败/.test(busy) ? " err" : "") }, busy) : null,
        h("div", { className: "oss-actions" },
          h(Btn, { variant: "primary", size: "sm", type: "submit" }, "导入"),
          h(Btn, { variant: "ghost", size: "sm", onClick: onClose }, "取消")
        )
      )
    }

    // ---- Lists ----
    function Hosts({ hosts, onEdit, onRefresh }) {
      async function del(code) {
        if (!confirm("删除主机 " + code + " ？")) return
        try { await api("/api/ops-ssh/hosts?code=" + encodeURIComponent(code), { method: "DELETE" }); onRefresh() }
        catch (e) { alert("删除失败：" + e.message) }
      }
      return h("div", { className: "oss-sec" },
        hosts.length === 0
          ? h("div", { className: "oss-empty" }, "（暂无主机）")
          : hosts.map((hst) => h("div", { key: hst.code, className: "oss-row" },
            h("div", { className: "oss-row-main" },
              h("b", null, hst.code),
              hst.alias ? h("span", { className: "oss-sub" }, hst.alias) : null,
              h("span", { className: "oss-mono" }, hst.username + "@" + hst.host + ":" + hst.port),
              h("span", { className: hst.review === "strict" ? "oss-badge-strict" : "oss-badge" }, hst.review === "strict" ? "严格" : "普通"),
              h("span", { className: "oss-sub" }, hst.sudo === "none" ? "sudo:关" : (hst.sudo === "password" ? "sudo:密码" : "sudo:自动")),
              hst.fingerprint ? null : h("span", { className: "oss-warn" }, "指纹未固定")
            ),
            h("div", { className: "oss-row-actions" },
              h(Btn, { variant: "outline", size: "sm", onClick: () => onEdit(hst) }, "编辑"),
              h(Btn, { variant: "ghost", size: "sm", onClick: () => del(hst.code) }, "删除")
            )
          ))
      )
    }
    function Keys({ keys, onRefresh }) {
      async function del(id) {
        if (!confirm("删除密钥「" + (id) + "」？")) return
        try { await api("/api/ops-ssh/keys?id=" + encodeURIComponent(id), { method: "DELETE" }); onRefresh() }
        catch (e) { alert("删除失败：" + e.message) }
      }
      return h("div", { className: "oss-sec" },
        keys.length === 0
          ? h("div", { className: "oss-empty" }, "（暂无 SSH 密钥）")
          : keys.map((k) => h("div", { key: k.id, className: "oss-row" },
            h("div", { className: "oss-row-main" },
              h("b", null, k.name || k.id),
              h("span", { className: "oss-sub" }, k.id === k.name ? null : k.id),
              h("span", { className: "oss-mono", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 } }, k.pubkey || "")
            ),
            h("div", { className: "oss-row-actions" },
              h(Btn, { variant: "ghost", size: "sm", onClick: () => del(k.id) }, "删除")
            )
          ))
      )
    }

    // ---- Top-level collapsible card ----
    function OpsSshCard() {
      const [open, setOpen] = useState(true)
      const [state, setState] = useState({ hosts: [], keys: [] })
      const [hostModal, setHostModal] = useState(null) // null | {edit: host | null}
      const [keyModal, setKeyModal] = useState(false)
      const [msg, setMsg] = useState("")

      async function refresh() {
        try {
          const r = await api("/api/ops-ssh/roster")
          setState({ hosts: r.hosts || [], keys: r.keys || [] })
          setMsg("")
        } catch (e) { setMsg("加载失败：" + e.message) }
      }
      useEffect(() => { refresh() }, [])

      async function doExport() {
        try { const r = await api("/api/ops-ssh/export"); jsonDownload("ops-ssh-roster.json", r.roster) }
        catch (e) { setMsg("导出失败：" + e.message) }
      }
      async function doImport(text) {
        try { await api("/api/ops-ssh/import", { method: "POST", headers: { "content-type": "application/json" }, body: text }); refresh(); setMsg("已导入") }
        catch (e) { setMsg("导入失败：" + e.message) }
      }
      function saved() { setHostModal(null); setKeyModal(false); refresh() }

      return h("div", { className: "oss-card" + (open ? " open" : "") },
        h("button", { type: "button", className: "oss-cardhead", onClick: () => setOpen(!open), "aria-expanded": open },
          h("span", { className: "oss-head-text" },
            h("span", { className: "oss-title" }, "运维 SSH 管理"),
            h("span", { className: "oss-desc" }, "按代号执行受控 SSH 命令；私钥/密码不出插件，严格主机逐命令审批。")
          ),
          Chevron(open)
        ),
        open ? h("div", { className: "oss-body" },
          h("div", { className: "oss-toolbar" },
            h(Btn, { variant: "ghost", size: "sm", onClick: refresh }, "刷新"),
            h(Btn, { variant: "outline", size: "sm", onClick: doExport }, "导出"),
            h("label", { className: "oss-ghostbtn", title: "导入配置（JSON，不含私钥）" },
              "导入",
              h("input", { type: "file", accept: ".json", style: { display: "none" }, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) { const rd = new FileReader(); rd.onload = () => doImport(String(rd.result)); rd.readAsText(f) } e.target.value = "" } })
            )
          ),
          h("div", { className: "oss-hint" }, "私钥/密码只存于 credentials，界面不回显、导出也不带走；导出仅含主机与公钥元数据。"),
          msg ? h("div", { className: "oss-msg" + (msg && msg.indexOf("失败") >= 0 ? " err" : "") }, msg) : null,
          h("div", { className: "oss-sec" },
            h("div", { className: "oss-sec-label" }, "主机"),
            h(Hosts, { hosts: state.hosts, onEdit: (host) => setHostModal({ edit: host }), onRefresh: refresh }),
            h("div", null, h(Btn, { variant: "primary", size: "sm", onClick: () => setHostModal({ edit: null }) }, "新增主机")),
          ),
          h("div", { className: "oss-sec" },
            h("div", { className: "oss-sec-label" }, "SSH 密钥"),
            h(Keys, { keys: state.keys, onRefresh: refresh }),
            h("div", null, h(Btn, { variant: "primary", size: "sm", onClick: () => setKeyModal(true) }, "导入私钥")),
          )
        ) : null,

        hostModal ? h(HostModal, { initial: hostModal.edit, keys: state.keys, onClose: () => setHostModal(null), onSaved: saved }) : null,
        keyModal ? h(KeyModal, { onClose: () => setKeyModal(false), onSaved: saved }) : null
      )
    }

    // ---- register into settings.plugin.item (like modlens) ----
    function apply(ctx) {
      const slots = (ctx && (ctx.slots || (ctx.get && ctx.get("slots")))) || null
      if (!slots) return
      if (ctx.effect) {
        ctx.effect(() => {
          const style = document.createElement("style")
          style.dataset.plugin = "ops-ssh-manager"
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, "ops-ssh-manager: styles")
      }
      slots.inject("settings.plugin.item", () => slots.register(
        { name: "settings.plugin.item", key: "ops-ssh-manager" },
        (props) => h(OpsSshCard, props)
      ))
    }

    exports.inject = ["slots"]
    exports.apply = apply
    return module.exports
  }
})