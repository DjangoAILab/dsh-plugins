// launcher.mjs — 自动拉起带调试端口的 Chrome（独立 profile 复用登录态）。
// 用 child_process.spawn(detached) 而非 ctx.subprocess：Chrome 是用户持续交互的长命 GUI 进程，
// 应脱离 DSH 进程树独立存活（DSH 重启不杀浏览器），且自愈——下次工具调用发现端点不在就重新拉起。
//
// Chrome ≥136 拒绝在默认 user-data-dir 上开远程调试，故必须给独立 --user-data-dir（见
// knowledge/domains/computer-use/observation-control-taxonomy.md 轴二）。

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveProfileDir } from './config.mjs'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/homebrew/bin/chromium',
]

export function resolveChromePath(cfg) {
  const candidates = cfg.chromePath ? [cfg.chromePath, ...CHROME_CANDIDATES] : CHROME_CANDIDATES
  return candidates.find((p) => existsSync(p)) || null
}

export function endpointPort(cfg) {
  try {
    return new URL(cfg.cdpEndpoint).port || '9222'
  } catch {
    return '9222'
  }
}

export async function isReachable(cfg) {
  try {
    const res = await fetch(cfg.cdpEndpoint + '/json/version')
    return res.ok
  } catch {
    return false
  }
}

/**
 * 启动 Chrome（detached，脱离 DSH），等 CDP 端点就绪后返回。
 * @param {object} cfg
 * @param {{ headless?: boolean }} [o] 覆盖 config.headless
 */
export async function launchChrome(cfg, o = {}) {
  if (await isReachable(cfg)) {
    return { already: true, endpoint: cfg.cdpEndpoint, profile: resolveProfileDir(cfg) }
  }
  const chrome = resolveChromePath(cfg)
  if (!chrome) {
    throw new Error('browser: 未找到 Chrome/Chromium，请配 config.chromePath 或安装 Chrome')
  }
  const headless = o.headless !== undefined ? o.headless : cfg.headless
  const args = [
    '--remote-debugging-port=' + endpointPort(cfg),
    '--user-data-dir=' + resolveProfileDir(cfg),
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (headless) args.push('--headless=new')
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' })
  child.unref()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await isReachable(cfg)) {
      return { already: false, pid: child.pid, endpoint: cfg.cdpEndpoint, profile: resolveProfileDir(cfg), headless }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('browser: Chrome 已拉起但 CDP 端点未就绪（' + cfg.cdpEndpoint + '），端口可能被占用或 Chrome 启动失败')
}

/** autoLaunch：端点不在就拉起。 */
export async function ensureBrowser(cfg) {
  if (await isReachable(cfg)) return
  await launchChrome(cfg)
}