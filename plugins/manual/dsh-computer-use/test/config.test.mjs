import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveConfig, resolveScreenshotDir, resolveDriverDir, resolveDriverPaths,
  nextScreenshotPath, resolveCacheBinDir, isDirWritable, sweepStaleProbeFiles,
} from '../src/config.mjs'

test('resolveConfig: defaults when empty', () => {
  const cfg = resolveConfig()
  assert.equal(cfg.approveActions, false)
  assert.equal(cfg.commandTimeoutMs, 15000)
  assert.equal(cfg.swiftcPath, '/usr/bin/swiftc')
  assert.equal(cfg.screenshotDir, '')
  assert.equal(cfg.screenshotMaxDimension, 1280)
})

test('resolveConfig: approveActions only true when exactly true（默认关，用户决议 2026-08-28）', () => {
  assert.equal(resolveConfig({ approveActions: true }).approveActions, true)
  assert.equal(resolveConfig({ approveActions: 'yes' }).approveActions, false)
  assert.equal(resolveConfig({ approveActions: 1 }).approveActions, false)
  assert.equal(resolveConfig({}).approveActions, false)
})

test('resolveConfig: commandTimeoutMs validated positive', () => {
  assert.equal(resolveConfig({ commandTimeoutMs: 30000 }).commandTimeoutMs, 30000)
  assert.equal(resolveConfig({ commandTimeoutMs: -5 }).commandTimeoutMs, 15000)
  assert.equal(resolveConfig({ commandTimeoutMs: 'x' }).commandTimeoutMs, 15000)
  assert.equal(resolveConfig({ commandTimeoutMs: 12.9 }).commandTimeoutMs, 12)
})

test('resolveConfig: swiftcPath trims; empty falls back to default', () => {
  assert.equal(resolveConfig({ swiftcPath: ' /opt/bin/swiftc ' }).swiftcPath, '/opt/bin/swiftc')
  assert.equal(resolveConfig({ swiftcPath: '   ' }).swiftcPath, '/usr/bin/swiftc')
})

test('resolveScreenshotDir: config wins over DSH_HOME', () => {
  assert.equal(resolveScreenshotDir({ screenshotDir: '/tmp/x' }, { DSH_HOME: '/custom/dsh' }), '/tmp/x')
})

test('resolveScreenshotDir: DSH_HOME fallback', () => {
  const dir = resolveScreenshotDir({}, { DSH_HOME: '/custom/dsh' })
  assert.equal(dir, '/custom/dsh/dsh-computer-use/screenshots')
})

test('resolveScreenshotDir: homedir fallback', () => {
  const dir = resolveScreenshotDir({}, {})
  assert.ok(dir.endsWith('.dsh/dsh-computer-use/screenshots'))
})

test('resolveDriverDir: config wins', () => {
  assert.equal(resolveDriverDir({ driverDir: '/opt/ax' }), '/opt/ax')
})

test('resolveDriverDir: infers <plugin>/driver relative to src/config.mjs', () => {
  const dir = resolveDriverDir({}, 'file:///repo/plugins/manual/dsh-computer-use/src/config.mjs')
  assert.equal(dir, '/repo/plugins/manual/dsh-computer-use/driver')
})

test('resolveDriverPaths: binary and source under dir', () => {
  const p = resolveDriverPaths({ driverDir: '/opt/ax' })
  assert.equal(p.binary, '/opt/ax/axdriver')
  assert.equal(p.source, '/opt/ax/axdriver.swift')
})

test('resolveConfig: screenshotMaxDimension validated (min 320)', () => {
  assert.equal(resolveConfig({ screenshotMaxDimension: 1920 }).screenshotMaxDimension, 1920)
  assert.equal(resolveConfig({ screenshotMaxDimension: 100 }).screenshotMaxDimension, 1280)
  assert.equal(resolveConfig({ screenshotMaxDimension: 'x' }).screenshotMaxDimension, 1280)
  assert.equal(resolveConfig({ screenshotMaxDimension: 640.9 }).screenshotMaxDimension, 640)
})

test('nextScreenshotPath: unique, png, under dir', () => {
  const a = nextScreenshotPath('/shots', 1700000000000)
  const b = nextScreenshotPath('/shots', 1700000000000)
  assert.match(a, /^\/shots\/shot-1700000000000-\d+\.png$/)
  assert.notEqual(a, b)
})

// ---- F9：编译缓存目录与目录可写探测 ----

test('resolveConfig: cacheBinDir trims; default empty（F9）', () => {
  assert.equal(resolveConfig({}).cacheBinDir, '')
  assert.equal(resolveConfig({ cacheBinDir: ' /opt/cu-bin ' }).cacheBinDir, '/opt/cu-bin')
})

test('resolveCacheBinDir: config wins over DSH_HOME; DSH_HOME 与 homedir 回退（F9）', () => {
  assert.equal(resolveCacheBinDir({ cacheBinDir: '/tmp/cu-bin' }, { DSH_HOME: '/custom/dsh' }), '/tmp/cu-bin')
  assert.equal(resolveCacheBinDir({}, { DSH_HOME: '/custom/dsh' }), '/custom/dsh/dsh-computer-use/bin')
  assert.ok(resolveCacheBinDir({}, {}).endsWith('.dsh/dsh-computer-use/bin'))
})

test('isDirWritable: 可写目录 true，不存在/只读目录 false（F9 真实探测）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-writable-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  assert.equal(isDirWritable(dir), true)
  assert.equal(isDirWritable('/proc/1/forbidden-cu-xyz'), false, '不存在的目录不可写')
  // 只读权限位（0o555）→ 探测文件打不开 → false（root 下 chmod 也可能被无视，故先降权再验）。
  chmodSync(dir, 0o555)
  try {
    assert.equal(isDirWritable(dir), process.geteuid?.() === 0 ? true : false, '只读目录按真实探测结果')
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('isDirWritable: 绝不删除/碰撞既有同名文件（QA 复审：sentinel 保留测试）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-probe-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  // QA 实证的旧缺陷形态：目录里放一个旧探测名同款 sentinel，探测后必须原样保留。
  const sentinel = join(dir, 'sentinel-data.txt')
  writeFileSync(sentinel, 'do-not-delete', 'utf8')
  assert.equal(isDirWritable(dir), true, '可写目录探测应通过')
  assert.equal(existsSync(sentinel), true, '既有文件必须保留')
  assert.equal(readFileSync(sentinel, 'utf8'), 'do-not-delete', '内容不被篡改')
  assert.equal(
    readdirSync(dir).filter((f) => f.includes('write-probe')).length,
    0,
    '探测文件必须清理干净，不留垃圾',
  )
})

test('isDirWritable: 探测文件名含随机后缀，并发进程不碰撞（QA 复审）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-probe-race-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  // 两次探测用不同随机名——第二次不应因第一次的残留（若有）而误判。
  assert.equal(isDirWritable(dir), true)
  assert.equal(isDirWritable(dir), true)
  assert.equal(readdirSync(dir).filter((f) => f.includes('write-probe')).length, 0)
})

test('sweepStaleProbeFiles: 只清同前缀超龄文件，不动新鲜/无关文件（QA 细节收尾）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-sweep-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } })
  const staleProbe = join(dir, '.dsh-computer-use-write-probe-123-abc')
  const freshProbe = join(dir, '.dsh-computer-use-write-probe-456-def')
  const unrelated = join(dir, '.dsh-computer-use-write-probe-like-name.txt')
  const otherHidden = join(dir, '.other-file')
  for (const f of [staleProbe, freshProbe, unrelated, otherHidden]) writeFileSync(f, 'x')
  // staleProbe 改成 2 小时前
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(staleProbe, old, old)
  const cleaned = sweepStaleProbeFiles(dir)
  assert.equal(cleaned, 1, '只清理超龄同前缀探针')
  assert.equal(existsSync(staleProbe), false)
  assert.equal(existsSync(freshProbe), true, '新鲜探针（别的进程可能在用）绝不动')
  assert.equal(existsSync(unrelated), true, '非探针前缀文件不动')
  assert.equal(existsSync(otherHidden), true, '无关隐藏文件不动')
})