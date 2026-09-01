// dsh-computer-use 配置解析：只认 cordis.patch.yml 里 composition 驱动的几个字段，
// 全部带默认值与防御性回退（坏配置不 fatal，回退到默认）。
// 设计权威见 knowledge/domains/computer-use/architecture-framework.md 与
// knowledge/domains/computer-use/accessibility-tree-drivers.md §五。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeSync, openSync, unlinkSync, readdirSync, statSync } from 'node:fs'

const DEFAULTS = Object.freeze({
  approveActions: false,
  commandTimeoutMs: 15000,
  driverDir: '',
  cacheBinDir: '',
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
  const cacheBinDir = typeof config.cacheBinDir === 'string' ? config.cacheBinDir.trim() : ''
  const swiftcPath =
    typeof config.swiftcPath === 'string' && config.swiftcPath.trim() !== ''
      ? config.swiftcPath.trim()
      : DEFAULTS.swiftcPath
  const screenshotDir = typeof config.screenshotDir === 'string' ? config.screenshotDir : ''
  const rawMax = Number(config.screenshotMaxDimension)
  const screenshotMaxDimension =
    Number.isFinite(rawMax) && rawMax >= 320 ? Math.floor(rawMax) : DEFAULTS.screenshotMaxDimension
  return {
    approveActions,
    commandTimeoutMs,
    driverDir,
    cacheBinDir,
    swiftcPath,
    screenshotDir,
    screenshotMaxDimension,
  }
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

/**
 * F9 编译缓存目录：driver 目录只读（只读安装/系统路径）时，编译产物回退到这里。
 * config.cacheBinDir 优先（测试注入用），否则 $DSH_HOME/dsh-computer-use/bin。
 */
export function resolveCacheBinDir(config = {}, env = process.env) {
  if (typeof config.cacheBinDir === 'string' && config.cacheBinDir.trim() !== '') {
    return config.cacheBinDir.trim()
  }
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-computer-use', 'bin')
}

/**
 * F9 目录可写探测：真实打开一个临时探测文件再删除——只读卷/权限/ACL 都按真实行为判定，
 * 不猜测 errno。安全约束（2026-08-31 QA 复审）：探测绝不能 pre-delete 任何既有文件——
 * 用 openSync 'wx'（独占创建）判定：同名文件已存在时探测直接失败（视为不可写），
 * 绝不 unlink 别人的文件；只清理本次成功创建的探测文件。
 * （QA 实证：旧实现固定文件名 + 预 unlink，sentinel 文件会被删除——数据丢失级缺陷。）
 */
export function isDirWritable(dir) {
  // 随机后缀 + 'wx' 独占创建：不与任何既有文件碰撞；并发进程天然不踩同一文件名。
  const probe = join(dir, '.dsh-computer-use-write-probe-' + process.pid + '-' + Math.random().toString(36).slice(2))
  let created = false
  try {
    const fd = openSync(probe, 'wx', 0o600)
    created = true
    closeSync(fd)
    return true
  } catch {
    return false
  } finally {
    // 只删除本次确实创建出来的探测文件；created=false 意味着没动过磁盘上任何东西。
    if (created) {
      try { unlinkSync(probe) } catch { /* best effort */ }
    }
  }
}

/**
 * 清理陈旧写探针残留（QA 细节收尾）：进程被 SIGKILL 时 finally 不执行，会留下
 * .dsh-computer-use-write-probe-<pid>-<rand> 残留（60 字节隐藏文件，无功能影响但会积累）。
 * 只删「同前缀 + mtime 超过 1 小时」的文件——正在进行的探测（别的进程刚创建的）绝不动。
 * best-effort：任何错误都吞掉，调用方只当顺带打扫。
 * @returns {number} 清理掉的文件数
 */
export function sweepStaleProbeFiles(dir, now = Date.now()) {
  const STALE_MS = 60 * 60 * 1000
  let cleaned = 0
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith('.dsh-computer-use-write-probe-')) continue
    const full = join(dir, name)
    try {
      if (now - statSync(full).mtimeMs < STALE_MS) continue
      unlinkSync(full)
      cleaned += 1
    } catch { /* 并发消失/权限不足——跳过 */ }
  }
  return cleaned
}

/** 单张截图文件路径：<screenshotDir>/shot-<ts>-<seq>.png。 */
let shotSeq = 0
export function nextScreenshotPath(screenshotDir, now = Date.now()) {
  shotSeq += 1
  return join(screenshotDir, 'shot-' + now + '-' + shotSeq + '.png')
}
