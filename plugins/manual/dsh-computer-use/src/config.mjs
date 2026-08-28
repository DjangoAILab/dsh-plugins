// dsh-computer-use 配置解析：只认 cordis.patch.yml 里 composition 驱动的几个字段，
// 全部带默认值与防御性回退（坏配置不 fatal，回退到默认）。
// 设计权威见 knowledge/domains/computer-use/architecture-framework.md 与
// knowledge/domains/computer-use/accessibility-tree-drivers.md §五。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULTS = Object.freeze({
  approveActions: false,
  commandTimeoutMs: 15000,
  driverDir: '',
  swiftcPath: '/usr/bin/swiftc',
  screenshotDir: '',
  screenshotMaxDimension: 1280,
})

export function resolveConfig(config = {}) {
  const approveActions = config.approveActions === true
  const rawTimeout = Number(config.commandTimeoutMs)
  const commandTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULTS.commandTimeoutMs
  const driverDir = typeof config.driverDir === 'string' ? config.driverDir.trim() : ''
  const swiftcPath =
    typeof config.swiftcPath === 'string' && config.swiftcPath.trim() !== ''
      ? config.swiftcPath.trim()
      : DEFAULTS.swiftcPath
  const screenshotDir = typeof config.screenshotDir === 'string' ? config.screenshotDir : ''
  const rawMax = Number(config.screenshotMaxDimension)
  const screenshotMaxDimension =
    Number.isFinite(rawMax) && rawMax >= 320 ? Math.floor(rawMax) : DEFAULTS.screenshotMaxDimension
  return { approveActions, commandTimeoutMs, driverDir, swiftcPath, screenshotDir, screenshotMaxDimension }
}

/** 截图落盘目录：config.screenshotDir 优先，否则 $DSH_HOME/dsh-computer-use/screenshots。 */
export function resolveScreenshotDir(config = {}, env = process.env) {
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.trim() !== '') {
    return config.screenshotDir.trim()
  }
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-computer-use', 'screenshots')
}

/**
 * driver 目录：config.driverDir 优先；否则按「源码树内相对位置」推断——
 * 本文件位于 <插件根>/src/config.mjs，driver 在 <插件根>/driver/。
 * bundle 安装后目录结构保持（package.json files 里有 driver），故相对推断在安装副本同样成立。
 */
export function resolveDriverDir(config = {}, importMetaUrl = import.meta.url) {
  if (typeof config.driverDir === 'string' && config.driverDir.trim() !== '') {
    return config.driverDir.trim()
  }
  return join(dirname(fileURLToPath(importMetaUrl)), '..', 'driver')
}

/** driver 可执行文件与 Swift 源码路径。 */
export function resolveDriverPaths(config = {}, importMetaUrl = import.meta.url) {
  const dir = resolveDriverDir(config, importMetaUrl)
  return { dir, binary: join(dir, 'axdriver'), source: join(dir, 'axdriver.swift') }
}

/** 窗口 id 探针（winid）的编译目录与产物路径：与 driver 同目录（driverDir 或其回退）。 */
export function resolveWinidPaths(config = {}, importMetaUrl = import.meta.url) {
  const dir = resolveDriverDir(config, importMetaUrl)
  return { dir, binary: join(dir, 'winid'), source: join(dir, 'winid.swift') }
}

/** 单张截图文件路径：<screenshotDir>/shot-<ts>-<seq>.png。 */
let shotSeq = 0
export function nextScreenshotPath(screenshotDir, now = Date.now()) {
  shotSeq += 1
  return join(screenshotDir, 'shot-' + now + '-' + shotSeq + '.png')
}
