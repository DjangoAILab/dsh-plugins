import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveConfig, resolveScreenshotDir, resolveDriverDir, resolveDriverPaths,
  resolveWinidPaths, nextScreenshotPath,
} from '../src/config.mjs'

test('resolveConfig: defaults when empty', () => {
  const cfg = resolveConfig()
  assert.equal(cfg.approveActions, false)
  assert.equal(cfg.commandTimeoutMs, 15000)
  assert.equal(cfg.swiftcPath, '/usr/bin/swiftc')
  assert.equal(cfg.screenshotDir, '')
  assert.equal(cfg.screenshotMaxDimension, 1280)
})

test('resolveConfig: approveActions only true when exactly true（默认关）', () => {
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

test('resolveWinidPaths: winid binary and source beside driver', () => {
  const p = resolveWinidPaths({ driverDir: '/opt/ax' })
  assert.equal(p.binary, '/opt/ax/winid')
  assert.equal(p.source, '/opt/ax/winid.swift')
})

test('nextScreenshotPath: unique, png, under dir', () => {
  const a = nextScreenshotPath('/shots', 1700000000000)
  const b = nextScreenshotPath('/shots', 1700000000000)
  assert.match(a, /^\/shots\/shot-1700000000000-\d+\.png$/)
  assert.notEqual(a, b)
})
