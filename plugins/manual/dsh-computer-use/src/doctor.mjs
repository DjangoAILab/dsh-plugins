// doctor.mjs — macOS TCC 权限自检（fail-closed）。
//
// 权限事实链（2026-08-28 宿主实测）：
//   - AX 读树授权授给「责任进程」（responsible process）。terminal→bash→axdriver 链上
//     AXIsProcessTrusted()=false，而 osascript 走 System Events（Apple Events 自动化）能通
//     ——两条授权通道不同：AX 裸 API 看责任进程的辅助功能授权，Apple Events 看自动化授权。
//   - 因此 doctor 的 AX 判定必须用**真实 AX 探针**（driver ping/doctor 上报 AXIsProcessTrusted()），
//     不能靠静态环境推断；授权缺席时输出精确指引，绝不半残运行。
//   - 屏幕录制授权用 CGPreflightScreenCaptureAccess()（driver doctor 上报，只查不弹窗），
//     screenshot 落盘是否可用据此判定。
//   - Lab 容器是 Linux：整个插件在非 darwin 平台 fail-closed（visible=false），容器里验证的
//     是「安装/加载/导入/工具注册」这条链，权限与 AX 能力只能在宿主 macOS 实测。
//
// 编译（2026-08-31 修复）：ensureDriverCompiled 单飞（同一 binary 的并发调用共享一次 swiftc），
// 源码比产物新则重编译；先编译到临时名再 fs.renameSync 原子落位（中断不留半个二进制）；
// 编译失败把 swiftc stderr 末 400 字符带进错误（此前误报 log 函数名，模型无从自愈）。
//
// 设计权威：knowledge/domains/computer-use/accessibility-tree-drivers.md §三/§四/§五。

import { spawn } from 'node:child_process'
import { existsSync, statSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDriverPaths, resolveCacheBinDir, isDirWritable, sweepStaleProbeFiles } from './config.mjs'

/** 单飞注册表：binary 路径 → in-flight 编译 Promise（同一目标并发只 spawn 一次 swiftc）。 */
const inflightCompiles = new Map()

function mtimeMsOf(path) {
  try { return statSync(path).mtimeMs } catch { return -1 }
}

/** 跑一次 swiftc，resolve [exitCode, 收集的 stderr]（spawn 失败视作 exit -1）。 */
function runSwiftc(swiftc, args) {
  return new Promise((resolve) => {
    const child = spawn(swiftc, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let settled = false
    const settle = (code) => {
      if (settled) return
      settled = true
      resolve([code, err])
    }
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += '\n' + e.message; settle(-1) })
    child.on('close', (c) => settle(c ?? -1))
  })
}

/**
 * 编译 driver（幂等：binary 存在且不比 source 旧则跳过；源码较新则重编译）。
 * 单飞：同一 binary 的并发调用共享 in-flight Promise（测试可断言只 spawn 一次 swiftc）。
 * F9：driver 目录只读（只读安装）时，二进制改落到可写缓存目录（resolveCacheBinDir），
 * 编译流程（mtime 判旧 + 临时名 + 原子落位）不变；源码仍在安装目录读（swiftc 只读源码，
 * 产物由 -o 指定路径）。返回值 binary 是实际落位路径——调用方不得再假设二进制在 driverDir。
 * @returns {Promise<{ ok: boolean, binary?: string, error?: string, compiled?: boolean }>}
 */
export async function ensureDriverCompiled(cfg, log = () => {}) {
  const { dir: sourceDir, source } = resolveDriverPaths(cfg)
  if (!existsSync(source)) {
    return { ok: false, error: 'driver 源码缺失: ' + source }
  }
  let dir = sourceDir
  if (!isDirWritable(dir)) {
    dir = resolveCacheBinDir(cfg)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch (e) {
      return { ok: false, error: 'driver 目录只读且编译缓存目录不可创建: ' + dir + ' (' + e.message + ')' }
    }
    // QA 复审（2026-08-31）：mkdir 对「已存在的只读目录」成功且不报错——
    // 二次探测保证后续 renameSync 落位不会撞裸 EACCES。
    if (!isDirWritable(dir)) {
      return {
        ok: false,
        error: 'driver 目录只读且编译缓存目录不可写: ' + dir +
          '（检查权限或用 config.driverDir/cacheBinDir 指到可写目录）',
      }
    }
  }
  const binary = join(dir, 'axdriver')
  const inflight = inflightCompiles.get(binary)
  if (inflight) return await inflight

  const job = (async () => {
    if (existsSync(binary) && mtimeMsOf(source) <= mtimeMsOf(binary)) {
      return { ok: true, binary, compiled: false }
    }
    const swiftc = cfg.swiftcPath || '/usr/bin/swiftc'
    if (!existsSync(swiftc)) {
      return { ok: false, error: 'swiftc 不存在: ' + swiftc + '（安装 Xcode Command Line Tools）' }
    }
    // 先编译到临时名：成功后 renameSync 原子替换（并发读/中途退出不留半个二进制）。
    const tmpBinary = binary + '.tmp-' + process.pid
    const [code, stderr] = await runSwiftc(swiftc, ['-O', '-o', tmpBinary, source])
    if (code !== 0) {
      try { if (existsSync(tmpBinary)) unlinkSync(tmpBinary) } catch { /* best effort */ }
      return {
        ok: false,
        error: 'swiftc 编译失败 (exit ' + code + '): ' + String(stderr).slice(-400),
      }
    }
    try {
      renameSync(tmpBinary, binary)
    } catch (e) {
      try { if (existsSync(tmpBinary)) unlinkSync(tmpBinary) } catch { /* best effort */ }
      return { ok: false, error: 'driver 二进制落位失败: ' + e.message }
    }
    log('driver compiled: ' + binary)
    // QA 细节收尾：编译成功 = 目录可写已验证——顺带打扫历史 SIGKILL 残留的探针文件。
    try { sweepStaleProbeFiles(dir) } catch { /* best effort */ }
    return { ok: true, binary, compiled: true }
  })()
  inflightCompiles.set(binary, job)
  try {
    return await job
  } finally {
    inflightCompiles.delete(binary)
  }
}

/** 向 driver 发一条请求并等应答（一次性进程，不做长驻——观察工具复用 session.mjs 的会话层）。 */
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

/** 静态先决：driver 二进制可编译 + swiftc 在位。F9：结果带实际落位的 binary 路径。 */
export async function staticChecks(cfg) {
  const items = []
  const build = await ensureDriverCompiled(cfg)
  items.push({
    name: 'driver-build',
    ok: build.ok,
    detail: build.ok ? (build.compiled ? '已现场编译' : '已存在，跳过编译') : build.error,
  })
  return { ok: build.ok, items, ...(build.binary ? { binary: build.binary } : {}) }
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
    '屏幕录制授权缺席（CGPreflightScreenCaptureAccess()=false），computer_screenshot 会失败：',
    '系统设置 → 隐私与安全性 → 屏幕录制，授权对象同辅助功能（DSH 责任进程）；',
    '已开启仍失败 → 先移除条目再重新添加（TCC 缓存坑），重新调用 computer_doctor 验证。',
  ].join('\n'),
}
