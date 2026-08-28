window.__ModuleLoader__.load({
  id: "dsh-file-upload-local",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require("react")
    const { createElement: h, Fragment, useState, useRef, useEffect, useCallback, memo } = react

    const SAVE_PATH = "/api/file-upload/save"
    const CONTENT_PATH = "/api/file-upload/content"
    // 前端不做硬限制（host 端 413 为最终裁决），仅超时保护
    const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000

    // ------------------------------------------------------------------
    // 从 window.__DSH_MODULES__ 复用产品组件（拿不到时降级，不硬依赖）
    // 参照 ds-attach 的 resolveModule 模式，已验证可用。
    // ------------------------------------------------------------------
    function realGlobal() {
      try { if (typeof window !== "undefined" && window) return window } catch (e) {}
      try { if (typeof globalThis !== "undefined" && globalThis) return globalThis } catch (e) {}
      return null
    }
    function pickNamed(mod, key) {
      if (!mod) return null
      if (typeof mod[key] === "function") return mod
      if (mod.default && typeof mod.default[key] === "function") return mod.default
      return null
    }
    const componentCache = {}
    function resolveComponent(spec, key) {
      const cacheKey = spec + "#" + key
      if (componentCache[cacheKey] !== undefined) return componentCache[cacheKey]
      let hit = null
      const g = realGlobal()
      const ms = g && g.__DSH_MODULES__
      if (ms) {
        const tries = []
        try { if (ms.seed && typeof ms.seed.get === "function") tries.push(ms.seed.get(spec)) } catch (e) {}
        try { if (ms.statics && typeof ms.statics.get === "function") tries.push(ms.statics.get(spec)) } catch (e) {}
        for (const t of tries) {
          const c = pickNamed(t, key)
          if (c) { hit = c; break }
        }
      }
      componentCache[cacheKey] = hit
      return hit
    }

    // ------------------------------------------------------------------
    // 文件标记（上传后插入草稿；user 渲染器据此渲染卡片）
    // 格式（连续 4 行，path 为受控绝对路径、不含换行）：
    //   [附件]name
    //   [路径]path
    //   [大小]bytes
    //   [类型]mime
    // ------------------------------------------------------------------
    const MARK_RE = /\[附件\]([^\r\n]+)[\r\n]+\[路径\]([^\r\n]+)[\r\n]+\[大小\](\d+)[\r\n]+\[类型\]([^\r\n]+)/g

    function markOf(file) {
      const safeName = String(file.name || "").replace(/[\r\n]+/g, " ").trim() || "file"
      const safeMime = String(file.mime || "").replace(/[\r\n]+/g, "") || "application/octet-stream"
      return "[附件]" + safeName + "\n[路径]" + file.path + "\n[大小]" + file.size + "\n[类型]" + safeMime
    }

    function extractFiles(text) {
      const files = []
      const plainParts = []
      const re = new RegExp(MARK_RE.source, "g")
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) plainParts.push(text.slice(last, m.index))
        files.push({ name: m[1], path: m[2], size: Number(m[3]) || 0, mime: m[4] })
        last = m.index + m[0].length
      }
      if (last < text.length) plainParts.push(text.slice(last))
      return { files, plain: plainParts.join("").trim() }
    }

    function fmtSize(n) {
      if (!n || n <= 0) return "0 B"
      const units = ["B", "KB", "MB", "GB", "TB"]
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return (i === 0 ? v : v.toFixed(1)) + " " + units[i]
    }

    function baseName(p) {
      const s = String(p || "")
      const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
      return i >= 0 ? s.slice(i + 1) : s
    }

    function isImageMime(mime) {
      return String(mime || "").indexOf("image/") === 0
    }

    // ------------------------------------------------------------------
    // 上传按钮（conversation.input.left）：点击弹系统选择器，XHR 流式上传
    // ------------------------------------------------------------------
    function UploadButton(props) {
      const { sessionId, inputActions, input } = props
      const [busy, setBusy] = useState(false)
      const [pct, setPct] = useState(0)
      const fileRef = useRef(null)
      const inputState = input
      const currentDraft = (inputState && typeof inputState.draft === "string") ? inputState.draft : ""

      const uploadOne = useCallback((sessionId, file) => {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest()
          xhr.open("POST", SAVE_PATH)
          xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name))
          xhr.setRequestHeader("x-session-id", String(sessionId || ""))
          xhr.timeout = UPLOAD_TIMEOUT_MS
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) setPct(Math.round((e.loaded / e.total) * 100))
          }
          xhr.onload = () => {
            let r
            try { r = JSON.parse(xhr.responseText) } catch (e) { r = { ok: false, error: "响应解析失败" } }
            resolve(Object.assign({}, r, { displayName: file.name }))
          }
          xhr.onerror = () => resolve({ ok: false, error: "网络错误" })
          xhr.ontimeout = () => resolve({ ok: false, error: "上传超时" })
          xhr.send(file)
        })
      }, [])

      const handleFiles = useCallback((fileList) => {
        const files = Array.from(fileList || [])
        if (files.length === 0 || !sessionId) return
        setBusy(true)
        setPct(0)
        Promise.all(files.map((f) => uploadOne(sessionId, f))).then((results) => {
          setBusy(false)
          const ok = results.filter((r) => r && r.ok === true)
          const errs = results.filter((r) => !r || r.ok !== true)
          if (ok.length > 0) {
            const marks = ok.map((r) => markOf({ name: r.displayName || baseName(r.name) || "file", path: r.path, size: r.size || 0, mime: r.mime || "application/octet-stream" }))
            const next = currentDraft === "" ? marks.join("\n") : currentDraft + "\n" + marks.join("\n")
            if (inputActions && typeof inputActions.setDraft === "function") inputActions.setDraft(next)
          }
          // 错误提示：轻量 toast 不可用时忽略，控制台记录
          if (errs.length > 0) console.warn("[dsh-file-upload-local] 部分文件失败:", errs)
        })
      }, [sessionId, uploadOne, currentDraft, inputActions])

      const label = busy ? "上传 " + pct + "%" : "📎 文件"
      return h("button", {
        type: "button",
        onClick: () => { if (fileRef.current) fileRef.current.click() },
        disabled: busy,
        title: "上传文件/图片到当前项目（不限图片）",
        style: {
          display: "inline-flex", alignItems: "center", gap: "4px", border: "none",
          borderRadius: "999px", cursor: busy ? "default" : "pointer", padding: "2px 10px",
          fontSize: "13px", lineHeight: "20px", fontWeight: 500, background: "transparent",
          color: "var(--dsw-alias-text-secondary, #666)", opacity: busy ? 0.6 : 1,
        },
      },
        label,
        h("input", {
          ref: fileRef, type: "file", multiple: true, style: { display: "none" },
          onChange: (e) => { handleFiles(e.target.files); e.target.value = "" },
        })
      )
    }

    // ------------------------------------------------------------------
    // 文件卡片（chat history 内：图片内联预览 / 通用图标 + 预览 + 下载）
    // ------------------------------------------------------------------
    function FileCard({ f, sessionId }) {
      const base = baseName(f.path)
      const image = isImageMime(f.mime)
      const contentUrl = CONTENT_PATH + "?sessionId=" + encodeURIComponent(sessionId || "") + "&name=" + encodeURIComponent(base)
      const downloadUrl = contentUrl + "&download=1"
      return h("div", { className: "dshfu-card" },
        image
          ? h("a", { href: contentUrl, target: "_blank", rel: "noopener", className: "dshfu-thumblink" },
              h("img", { className: "dshfu-thumb", src: contentUrl, alt: f.name, loading: "lazy" }))
          : h("div", { className: "dshfu-icon" }, "📄"),
        h("div", { className: "dshfu-meta" },
          h("div", { className: "dshfu-name" }, f.name),
          h("div", { className: "dshfu-sub" }, fmtSize(f.size) + (f.mime ? " · " + f.mime : ""))
        ),
        h("div", { className: "dshfu-actions" },
          h("a", { className: "dshfu-act", href: contentUrl, target: "_blank", rel: "noopener" }, "预览"),
          h("a", { className: "dshfu-act", href: downloadUrl }, "下载")
        )
      )
    }

    // ------------------------------------------------------------------
    // user 节点渲染器：接管 (priority -1) 以渲染文件卡片。
    // 无文件标记时按产品原样：原生图片画廊 + 纯文本气泡。
    // ------------------------------------------------------------------
    const UserNodeView = memo(function UserNodeView(props) {
      const { node, loadImage, sessionId } = props
      const data = node && node.data
      const content = (data && Array.isArray(data.content)) ? data.content : []
      let text = ""
      const images = []
      const rest = []
      for (const block of content) {
        const b = block || {}
        if (b.type === "text" && typeof b.text === "string") text += b.text
        else if (b.type === "image" && b.attachment !== undefined) images.push({ attachment: b.attachment })
        else rest.push(block)
      }
      const { files, plain } = extractFiles(text)

      const ImageGallery = resolveComponent("@deepseek-ai/dsh-client-ui-attachment", "ImageGallery")
      const MessageText = resolveComponent("@deepseek-ai/dsh-client-ui-primitives", "MessageText")

      const gallery = images.length > 0
        ? (ImageGallery
            ? h(ImageGallery, { images, load: loadImage, align: "end", labels: { image: "图片", loading: "加载中…", retry: "重试", lightbox: "查看原图" } })
            : h("div", { className: "dshfu-rail" }, images.map((img, i) => h("div", { key: i, className: "dshfu-icon" }, "🖼️"))))
        : null

      const fileCards = files.length > 0
        ? h("div", { className: "dshfu-rail" }, files.map((f, i) => h(FileCard, { key: "f" + i, f, sessionId })))
        : null

      const showBubble = plain !== "" || rest.length > 0
      const bubbleChildren = plain
        ? (MessageText ? h(MessageText, { text: plain }) : h("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, plain))
        : null
      const bubble = showBubble ? h("div", { className: "dshfu-bubble" }, bubbleChildren) : null

      return h("div", { className: "dshfu-userrow", "data-time-hover-root": true },
        h("div", { className: "dshfu-userstack" }, gallery, fileCards, bubble)
      )
    })

    // ------------------------------------------------------------------
    // 样式
    // ------------------------------------------------------------------
    const CSS = [
      ".dshfu-userrow { display:flex; flex-direction:column; align-items:flex-end; gap:6px; width:100%; }",
      ".dshfu-userstack { display:flex; flex-direction:column; align-items:flex-end; gap:8px; min-width:0; max-width:min(525px, 82%); }",
      ".dshfu-bubble { background:var(--dsw-specific-bubble); max-width:100%; color:var(--dsw-alias-label-primary); border-radius:22px; padding:10px 16px; font-size:16px; line-height:24px; overflow-wrap:anywhere; }",
      ".dshfu-rail { display:flex; flex-direction:column; gap:6px; align-items:flex-end; width:100%; }",
      ".dshfu-card { display:flex; align-items:center; gap:10px; width:240px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-specific-input-major, var(--dsw-alias-bg-l2, #262626)); border-radius:16px; padding:10px 12px; box-sizing:border-box; }",
      ".dshfu-thumblink { flex:none; }",
      ".dshfu-thumb { width:40px; height:40px; border-radius:8px; object-fit:cover; display:block; }",
      ".dshfu-icon { width:40px; height:40px; flex:none; display:flex; align-items:center; justify-content:center; border-radius:8px; background:var(--dsw-alias-interactive-bg-hover); font-size:18px; }",
      ".dshfu-meta { min-width:0; flex:1 1 auto; }",
      ".dshfu-name { font-size:14px; font-weight:500; color:var(--dsw-alias-label-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".dshfu-sub { font-size:12px; color:var(--dsw-alias-label-tertiary); margin-top:2px; }",
      ".dshfu-actions { display:flex; gap:2px; flex:none; }",
      ".dshfu-act { font-size:12px; color:var(--dsw-alias-text-secondary, #999); text-decoration:none; cursor:pointer; padding:2px 6px; border-radius:6px; white-space:nowrap; }",
      ".dshfu-act:hover { background:var(--dsw-alias-interactive-bg-hover); }",
    ].join("\n")

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------
    function apply(ctx) {
      const slots = (ctx && (ctx.slots || (ctx.get && ctx.get("slots")))) || null
      if (!slots) return

      if (ctx.effect) {
        ctx.effect(() => {
          const style = document.createElement("style")
          style.dataset.plugin = "dsh-file-upload-local"
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, "dsh-file-upload-local: styles")
      }

      slots.inject("conversation.input.left", () => slots.register(
        { name: "conversation.input.left", id: "dsh-file-upload-local", order: -30 },
        (p) => h(UploadButton, p)
      ))

      slots.inject("conversation.chat.node", () => slots.register(
        { name: "conversation.chat.node", key: "user", priority: -1 },
        UserNodeView
      ))
    }

    exports.inject = ["slots"]
    exports.apply = apply
    return module.exports
  }
})
