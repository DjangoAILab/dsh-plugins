// dsh-browser-control 配置解析：只认 cordis.patch.yml 里 composition 驱动的几个字段，
// 全部带默认值与防御性回退（坏配置不 fatal，回退到默认）。
// 设计权威见 knowledge/domains/computer-use/architecture-framework.md。

import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = Object.freeze({
  cdpEndpoint: 'http://127.0.0.1:9222',
  approveActions: false,
  commandTimeoutMs: 15000,
  screenshotDir: '',
  autoLaunch: true,
  chromePath: '',
  headless: false,
  profileDir: '',
})

export function resolveConfig(config = {}) {
  const cdpEndpoint =
    typeof config.cdpEndpoint === 'string' && config.cdpEndpoint.trim() !== ''
      ? config.cdpEndpoint.trim().replace(/\/+$/, '')
      : DEFAULTS.cdpEndpoint
  const approveActions = config.approveActions === true
  const rawTimeout = Number(config.commandTimeoutMs)
  const commandTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULTS.commandTimeoutMs
  const screenshotDir = typeof config.screenshotDir === 'string' ? config.screenshotDir : ''
  const autoLaunch = config.autoLaunch !== false
  const chromePath = typeof config.chromePath === 'string' ? config.chromePath : ''
  const headless = config.headless === true
  const profileDir = typeof config.profileDir === 'string' ? config.profileDir : ''
  return { cdpEndpoint, approveActions, commandTimeoutMs, screenshotDir, autoLaunch, chromePath, headless, profileDir }
}

/** 截图落盘目录：config.screenshotDir 优先，否则 $DSH_HOME/dsh-browser-control/screenshots。 */
export function resolveScreenshotDir(config = {}, env = process.env) {
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.trim() !== '') {
    return config.screenshotDir.trim()
  }
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-browser-control', 'screenshots')
}

/** Chrome 独立 profile 目录（登录态常驻这里）：config.profileDir 优先，否则 ~/dsh-browser-profile。 */
export function resolveProfileDir(config = {}) {
  if (typeof config.profileDir === 'string' && config.profileDir.trim() !== '') {
    return config.profileDir.trim()
  }
  return join(homedir(), 'dsh-browser-profile')
}