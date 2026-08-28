// dsh-computer-use —— Host 半场入口（阶段①：观察闭环）。
//
// 职责：经 macOS Accessibility API（AXUIElement，Swift helper `axdriver`）把本机 GUI app
// 变成 AX 快照优先的元素级工具集（computer_doctor / computer_list_apps / computer_windows /
// computer_snapshot）。阶段②补动作类（click/type/key/scroll/menu/app），阶段③补
// computer_screenshot（screencapture 落盘 + modlens 读图链路）。
//
// 设计权威见 knowledge/domains/computer-use/architecture-framework.md（ADR-1/ADR-3、P2）与
// knowledge/domains/computer-use/accessibility-tree-drivers.md（§五 设计决议）。
// 与 dsh-browser-control（浏览器 DOM/CDP）是**两个插件**（ADR-1）。

import { resolveConfig } from './config.mjs'
import { platformCheck } from './doctor.mjs'
import { mountComputerTools } from './tools.mjs'

export const name = 'dsh-computer-use'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const plat = platformCheck()
  if (!plat.supported) {
    // fail-closed：非 macOS 平台不注册任何工具，仅在日志留一条原因（Lab 容器走这条）。
    try { ctx?.logger?.info?.('[dsh-computer-use] disabled: ' + plat.reason) } catch { /* logger optional */ }
    return
  }
  ctx.effect(() => mountComputerTools(ctx, cfg), 'dsh-computer-use: tools')
}
