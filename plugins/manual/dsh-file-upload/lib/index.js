// dsh-file-upload — Host half (local hand-rolled fork of a903067276-rgb/dsh-file-upload).
// Key change vs upstream: STREAMING body (no base64), so the upload size limit is
// bounded only by DSH_FILE_UPLOAD_MAX_BYTES (default 1 GiB) instead of ~25 MiB.
//
// Why streaming works: DSH's webServer service hands the raw IncomingMessage to the
// route handler without pre-reading the body and with no global size cap
// (@deepseek-ai/dsh-host-webserver/lib/index.js — createServer(req,res) => handler).
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join, extname, basename, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'

export const name = 'dsh-file-upload-local'
export const inject = ['webServer', 'sessions']

const SAVE_PATH = '/api/file-upload/save'
const CONTENT_PATH = '/api/file-upload/content'
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB, overridable via env

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

function mimeOf(name) {
  return MIME[extname(name).toLowerCase()] || 'application/octet-stream'
}

function maxBytes() {
  const v = Number(process.env.DSH_FILE_UPLOAD_MAX_BYTES)
  return Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_MAX_BYTES
}

function header(req, key) {
  const v = req.headers[key]
  return typeof v === 'string' ? v : undefined
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

function resolveSession(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const session = sessions.get(sessionId)
  const cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? { session, cwd } : undefined
}

function sanitizeName(value) {
  let base = String(value || '')
  try { base = decodeURIComponent(base) } catch (e) { /* keep as-is */ }
  base = base.split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f]/g, '_')
  base = base.replace(/[\\/]/g, '_')
  base = base.replace(/\s+/g, ' ').trim()
  base = base.replace(/[. ]+$/, '')
  if (base === '' || base === '.' || base === '..') return 'file'
  return base.slice(0, 180)
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const sessions = ctx.sessions
  if (!webServer || !sessions) return

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SAVE_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const sessionId = header(req, 'x-session-id')
        const rawName = header(req, 'x-file-name')
        const sc = resolveSession(sessions, sessionId)
        if (!sc) return sendJson(res, 400, { ok: false, error: 'session missing or has no cwd' })
        if (rawName === undefined || rawName === '') return sendJson(res, 400, { ok: false, error: 'missing file name' })

        const storedName = Date.now() + '-' + sanitizeName(rawName)
        const dir = join(sc.cwd, 'uploads')
        await mkdir(dir, { recursive: true })
        const target = join(dir, storedName)
        const limit = maxBytes()
        const ws = createWriteStream(target, { flags: 'wx' })
        let size = 0
        let overflow = false
        try {
          for await (const chunk of req) {
            size += chunk.length
            if (size > limit) { overflow = true; ws.destroy(); break }
            if (!ws.write(chunk)) await once(ws, 'drain')
          }
          if (!overflow) ws.end()
          await finished(ws)
        } catch (e) {
          ws.destroy()
          // best-effort cleanup of the partial file
          const { unlink } = await import('node:fs/promises')
          await unlink(target).catch(() => {})
          return sendJson(res, 400, { ok: false, error: 'upload interrupted' })
        }
        if (overflow) {
          const { unlink } = await import('node:fs/promises')
          await unlink(target).catch(() => {})
          return sendJson(res, 413, { ok: false, error: 'file too large (limit ' + limit + ' bytes)' })
        }
        sendJson(res, 200, { ok: true, name: storedName, path: target, size, mime: mimeOf(storedName) })
      } catch (e) {
        console.error('[dsh-file-upload] save failed:', e)
        try { sendJson(res, 500, { ok: false, error: 'save failed' }) } catch (e2) { /* ignore */ }
      }
    },
  }), 'dsh-file-upload: save route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: CONTENT_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url || '/', 'http://x')
        const sessionId = url.searchParams.get('sessionId')
        const name = url.searchParams.get('name')
        const download = url.searchParams.get('download') === '1'
        const sc = resolveSession(sessions, sessionId)
        if (!sc) return sendJson(res, 400, { ok: false, error: 'session missing' })
        const safe = basename(String(name || ''))
        if (safe === '' || safe === '.' || safe === '..') return sendJson(res, 400, { ok: false, error: 'invalid file name' })
        const dir = resolve(join(sc.cwd, 'uploads'))
        const target = resolve(dir, safe)
        // path-traversal guard: target must live inside the session uploads dir
        if (!target.startsWith(dir + sep)) return sendJson(res, 403, { ok: false, error: 'forbidden path' })
        const info = await stat(target).catch(() => undefined)
        if (!info || !info.isFile()) return sendJson(res, 404, { ok: false, error: 'file not found' })
        const mime = mimeOf(safe)
        const disposition = download
          ? "attachment; filename*=UTF-8''" + encodeURIComponent(safe)
          : 'inline'
        res.writeHead(200, {
          'content-type': mime,
          'content-length': info.size,
          'content-disposition': disposition,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        })
        if (req.method === 'HEAD') { res.end(); return }
        const rs = createReadStream(target)
        rs.on('error', (e) => res.destroy(e))
        rs.pipe(res)
      } catch (e) {
        console.error('[dsh-file-upload] content failed:', e)
        try { sendJson(res, 500, { ok: false, error: 'read failed' }) } catch (e2) { /* ignore */ }
      }
    },
  }), 'dsh-file-upload: content route')
}
