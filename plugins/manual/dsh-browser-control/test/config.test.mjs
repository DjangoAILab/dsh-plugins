import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, resolveScreenshotDir, resolveProfileDir } from '../src/config.mjs'

test('resolveConfig: defaults when empty', () => {
  const cfg = resolveConfig()
  assert.equal(cfg.cdpEndpoint, 'http://127.0.0.1:9222')
  assert.equal(cfg.approveActions, false)
  assert.equal(cfg.commandTimeoutMs, 15000)
  assert.equal(cfg.autoLaunch, true)
  assert.equal(cfg.headless, false)
})

test('resolveConfig: trims trailing slash and whitespace', () => {
  const cfg = resolveConfig({ cdpEndpoint: ' http://127.0.0.1:9222/// ' })
  assert.equal(cfg.cdpEndpoint, 'http://127.0.0.1:9222')
})

test('resolveConfig: approveActions only true when exactly true', () => {
  assert.equal(resolveConfig({ approveActions: true }).approveActions, true)
  assert.equal(resolveConfig({ approveActions: 'yes' }).approveActions, false)
  assert.equal(resolveConfig({ approveActions: 1 }).approveActions, false)
})

test('resolveConfig: commandTimeoutMs validated positive', () => {
  assert.equal(resolveConfig({ commandTimeoutMs: 30000 }).commandTimeoutMs, 30000)
  assert.equal(resolveConfig({ commandTimeoutMs: -5 }).commandTimeoutMs, 15000)
  assert.equal(resolveConfig({ commandTimeoutMs: 'x' }).commandTimeoutMs, 15000)
  assert.equal(resolveConfig({ commandTimeoutMs: 12.9 }).commandTimeoutMs, 12)
})

test('resolveScreenshotDir: config wins over DSH_HOME', () => {
  assert.equal(resolveScreenshotDir({ screenshotDir: '/tmp/x' }, { DSH_HOME: '/custom/dsh' }), '/tmp/x')
})

test('resolveScreenshotDir: DSH_HOME fallback', () => {
  const dir = resolveScreenshotDir({}, { DSH_HOME: '/custom/dsh' })
  assert.equal(dir, '/custom/dsh/dsh-browser-control/screenshots')
})

test('resolveScreenshotDir: homedir fallback', () => {
  const dir = resolveScreenshotDir({}, {})
  assert.ok(dir.endsWith('.dsh/dsh-browser-control/screenshots'))
})

test('resolveConfig: autoLaunch can be disabled explicitly', () => {
  assert.equal(resolveConfig({ autoLaunch: false }).autoLaunch, false)
})

test('resolveProfileDir: config wins, else ~/dsh-browser-profile', () => {
  assert.equal(resolveProfileDir({ profileDir: '/tmp/p' }), '/tmp/p')
  assert.ok(resolveProfileDir({}).endsWith('dsh-browser-profile'))
})