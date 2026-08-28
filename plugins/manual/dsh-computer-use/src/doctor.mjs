// doctor.mjs — macOS TCC 权限自检（fail-closed）。
//
// 权限事实链（2026-08-28 宿主实测）：
//   - AX 读树授权授给「责任进程」（responsible process）。terminal→bash→axdriver 链上
//     AXIsProcessTrusted()=false，而 osascript 走 System Events（Apple Events 自动化）能通
//     ——两条授权通道不同：AX 裸 API 看责任进程的辅助功能授权，Apple Events 看自动化授权。
//   - 因此 doctor 的 AX 判定必须用**真实 AX 探针**（driver ping/doctor 上报 AXIsProcessTrusted()），
//     不能靠静态环境推断；授权缺席时输出精确指引，绝不半残运行。
//   - Lab 容器是 Linux：整个插件在非 darwin 平台 fail-closed（visible=false），容器里验证的
//     是「安装/加载/导入/工具注册」这条链，权限与 AX 能力只能在宿主 macOS 实测。
//
// 设计权威：knowledge/domains/computer-use/accessibility-tree-drivers.md §三/§四/§五。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveDriverPaths } from './config.mjs'

/**
 * 编译 driver（幂等：binary 比 source 新则跳过）。
 * @returns {Promise<{ ok: boolean, binary?: string, error?: string, compiled?: boolean }>}
 */
export async function ensureDriverCompiled(cfg, log = () => {}) {
  const { binary, source } = resolveDriverPaths(cfg)
  if (!existsSync(source)) {
    return { ok: false, error: 'driver 源码缺失: ' + source }
  }
  if (existsSync(binary)) {
    return { ok: true, binary, compiled: false }
  }
  const swiftc = cfg.swiftcPath || '/usr/bin/swiftc'
  if (!existsSync(swiftc)) {
    return { ok: false, error: 'swiftc 不存在: ' + swiftc + '（安装 Xcode Command Line Tools）' }
  }
  const code = await new Promise((resolve) => {
    const child = spawn(swiftc, ['-O', '-o', binary, source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve(-1))
    child.stderr.on('end', () => { child.axErr = err })
    child.on('close', (c) => resolve(c ?? -1))
  })
  if (code !== 0 || !existsSync(binary)) {
    return { ok: false, error: 'swiftc 编译失败 (exit ' + code + '): ' + String(log && log.name) }
  }
  log('driver compiled: ' + binary)
  return { ok: true, binary, compiled: true }
}

/** 向 driver 发一条请求并等应答（一次性进程，不做长驻——观察工具复用 driver.mjs 的会话层）。 */
export function driverProbe(binary, request, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already dead */ }
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'driver probe timeout' }), timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl >= 0) {
        try {
          done({ ok: true, reply: JSON.parse(out.slice(0, nl)) })
        } catch (e) {
          done({ ok: false, error: 'driver reply parse failed: ' + e.message })
        }
      }
    })
    child.on('error', (e) => done({ ok: false, error: 'driver spawn failed: ' + e.message }))
    child.stdin.end(JSON.stringify(request) + '\n')
  })
}

/**
 * 平台门槛：非 darwin 直接 fail-closed。
 * @returns {{ supported: boolean, reason?: string }}
 */
export function platformCheck(platform = process.platform) {
  if (platform === 'darwin') return { supported: true }
  return {
    supported: false,
    reason: 'dsh-computer-use 需要 macOS（当前 ' + platform + '）；Windows/Linux driver 未来以独立 runtime 形式提供',
  }
}

/** 静态先决：driver 二进制可编译 + swiftc 在位。 */
export async function staticChecks(cfg) {
  const items = []
  const build = await ensureDriverCompiled(cfg)
  items.push({
    name: 'driver-build',
    ok: build.ok,
    detail: build.ok ? (build.compiled ? '已现场编译' : '已存在，跳过编译') : build.error,
  })
  return { ok: build.ok, items }
}

export const GUIDANCE = {
  accessibility: [
    '辅助功能授权缺席（AXIsProcessTrusted()=false）。授权对象是 DSH 的责任进程，不是 axdriver：',
    '1) 系统设置 → 隐私与安全性 → 辅助功能；',
    '2) 把运行 DSH 的条目加进去并打开（终端里跑的 DSH 加终端 app；launchd 常驻的加对应宿主条目）；',
    '3) 已在列表仍失败 → 先移除条目再重新添加（TCC 缓存常见坑）；',
    '4) 重新调用 computer_doctor 验证（授权即时生效，无需重启 DSH）。',
  ].join('\n'),
  screenRecording: [
    '屏幕录制授权待验证（阶段③ screenshot 需要；AX 快照不依赖它）：',
    '系统设置 → 隐私与安全性 → 屏幕录制，授权对象同辅助功能（DSH 责任进程）。',
  ].join('\n'),
}
