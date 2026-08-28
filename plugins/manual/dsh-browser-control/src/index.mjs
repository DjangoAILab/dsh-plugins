// dsh-browser-control —— Host 半场入口。
//
// 职责：经 Chrome DevTools Protocol（CDP）把「本机已登录浏览器」变成 DOM 快照优先的
// 短交互工具集（browser_pages / browser_navigate / browser_snapshot / browser_click /
// browser_type / browser_extract）；敏感动作（click/type）可选走 userQuestions.ask 人工审批。
//
// 设计权威见 knowledge/domains/computer-use/architecture-framework.md（ADR-1/ADR-3、P0）。
// 与 dsh-computer-use（视觉整机）是**两个插件**，本插件只做浏览器 DOM/Cdp。

import { resolveConfig } from './config.mjs'
import { mountBrowserTools } from './tools.mjs'

export const name = 'dsh-browser-control'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  ctx.effect(() => mountBrowserTools(ctx, cfg), 'dsh-browser-control: tools')
}