// 测试基建（QA FIX-7）：把**当前工作树**的 driver/axdriver.swift 编译一次进临时目录，
// 供所有需要真实二进制的测试共用——绝不 spawn driver/axdriver 陈旧产物（QA 曾实测该产物
// 落后于源码，测试验证的是旧行为）。
//
// 单飞：模块级 Promise 共享一次 swiftc（同一测试进程内多测试复用同一二进制）。
// 跳过模式：swiftc 不可用或编译失败 → { available:false, reason }，调用方以
// `t.skip(reason)` 跳过并带清晰原因（这些测试只在宿主 macOS + CLT 环境运行）。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const DRIVER_SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'driver', 'axdriver.swift')

let inflight = null

function runSwiftcOnce() {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'axdriver-test-build-'))
    const binary = join(dir, 'axdriver')
    const finish = (result) => resolve({ dir, binary, ...result })
    if (!existsSync(DRIVER_SOURCE)) {
      finish({ available: false, reason: 'driver 源码缺失: ' + DRIVER_SOURCE })
      return
    }
    const child = spawn('/usr/bin/swiftc', ['-O', '-o', binary, DRIVER_SOURCE], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => finish({
      available: false,
      reason: 'swiftc 不可用（' + e.message + '）；安装 Xcode Command Line Tools 后重试',
    }))
    child.on('close', (code) => {
      if (code === 0) {
        finish({ available: true })
      } else {
        finish({
          available: false,
          reason: 'swiftc 编译失败 (exit ' + code + '): ' + String(err).slice(-300),
        })
      }
    })
  })
}

/**
 * 编译当前工作树 driver（单飞）。返回 { available:true, dir, binary } 或
 * { available:false, dir, binary, reason }（reason 供 t.skip 展示）。
 * 编译产物留在系统临时目录（OS 自清），不做进程内删除——单飞共享的目录
 * 不能被先结束的测试拆掉。
 */
export function compileDriverForTest() {
  if (!inflight) {
    inflight = runSwiftcOnce()
    // 单飞失败也缓存结果：本进程内不再重试（跳过模式确定）。
    inflight.catch(() => {})
  }
  return inflight
}
