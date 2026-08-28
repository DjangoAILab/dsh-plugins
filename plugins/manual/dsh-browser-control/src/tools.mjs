// dsh-browser-control —— 模型可见工具集（P0 短交互闭环）：
//   browser_pages   列出 CDP 端点的 page target（tab）
//   browser_navigate 导航到 URL 并等待加载
//   browser_snapshot 渲染 a11y 树快照（DOM 快照优先，带稳定 ref）
//   browser_click   ref 或 selector 点元素（敏感，可选审批）
//   browser_type    ref 或 selector 聚焦后输入文本（敏感，可选审批）
//   browser_extract 取元素/页面文本（input 返回 value）
//
// 每次工具调用都重连 + 可选 targetId 选 tab（默认首个 page target）+ 用后即关，
// ref 到 backendDOMNodeId 的映射在每次动作时重算，保证快照与点击自洽。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { evaluate, waitForLoad, listTargets, createTarget, closeTarget, activateTarget } from './cdp.mjs'
import {
  snapshot, resolvePoint, mouseClick, typeText, waitForAccessibility,
  goBack, goForward, reload, fillValue, selectOption, hover, scroll, pressKey, drag,
  waitFor, handleDialog, setFiles, getCookies, deleteCookies,
} from './actions.mjs'
import { requestActionApproval } from './approve.mjs'
import { acquire, closeSession, closeAll } from './session.mjs'
import { resolveScreenshotDir } from './config.mjs'
import { ensureBrowser, launchChrome } from './launcher.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** autoLaunch 时确保 Chrome 在跑，再取连接条目。 */
async function withBrowser(cfg, targetId) {
  if (cfg.autoLaunch) await ensureBrowser(cfg)
  return acquire(cfg.cdpEndpoint, targetId, cfg.commandTimeoutMs)
}

async function withClient(cfg, fn, targetId) {
  const { client } = await withBrowser(cfg, targetId)
  return await fn(client)
}

/** 敏感动作审批闸（approveActions=false 时为空操作）。 */
async function gate(ctx, cfg, exec, tool, detail) {
  if (!cfg.approveActions) return
  const decision = await requestActionApproval(ctx, { agent: exec.agent, tool, detail })
  if (decision.verdict === 'denied') throw new Error(tool + ' denied: ' + decision.reason)
}

const TARGET_SCHEMA = {
  ref: { type: 'string', description: '目标 ref（形如 @5，来自 browser_snapshot 输出）。' },
  selector: { type: 'string', description: 'CSS 选择器，作为 ref 缺失时的定位方式。' },
}

const TARGET_ID_SCHEMA = {
  targetId: { type: 'string', description: '目标标签页 id（来自 browser_pages 输出的 id）；省略操作第一个 page target。' },
}

export function mountBrowserTools(ctx, cfg) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_pages',
    description: '列出 CDP 端点上的浏览器 page target（标签页：id / title / url / type）。不操作任何页面。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          pages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                type: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pages.length === 0
          ? '(no page targets)'
          : value.pages.map((p) => '- [' + p.type + '] id=' + p.id + ' ' + (p.title || '(untitled)') + '  ' + p.url).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const targets = await listTargets(cfg.cdpEndpoint)
      const pages = targets
        .filter((t) => t && t.type === 'page')
        .map((t) => ({ id: t.id || '', title: t.title || '', url: t.url || '', type: t.type || '' }))
      return { pages }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: '导航到指定 URL 并等待页面加载完成。登录态复用：连的是本机已登录 Chrome（--remote-debugging-port）。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      url: { type: 'string', required: true, description: '目标完整 URL（含协议）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'navigated to ' + value.url + (value.title ? ' — ' + value.title : '') }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return withClient(cfg, async (client) => {
        await client.send('Page.navigate', { url: String(args.url) })
        await waitForLoad(client)
        await waitForAccessibility(client)
        const title = await evaluate(client, 'document.title')
        return { url: String(args.url), title: typeof title === 'string' ? title : '' }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description:
      '渲染当前页面的可访问性（a11y）树快照为结构化文本（DOM 快照优先，比截图便宜且确定性高）。' +
      '每个可交互元素带 [ref=@N]，供 browser_click / browser_type 精准命中。',
    parameters: {
      ...TARGET_ID_SCHEMA,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const { text } = await snapshot(client)
        return { text }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_click',
    description: '点击页面上 ref（来自 browser_snapshot）或 CSS selector 定位的元素。敏感动作，可能触发审批。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      ...TARGET_SCHEMA,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { clicked: { type: 'boolean', required: true }, target: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: 'clicked ' + (value.target || 'element') }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_click', '点击：' + (args.ref || args.selector || '?'))
      return withClient(cfg, async (client) => {
        const point = await resolvePoint(client, args)
        await mouseClick(client, point.x, point.y)
        return { clicked: true, target: args.ref || args.selector || '' }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_type',
    description: '点击聚焦 ref / selector 定位的元素后输入纯文本。敏感动作，可能触发审批。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      ...TARGET_SCHEMA,
      text: { type: 'string', required: true, description: '要输入的文本。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { typed: { type: 'string', required: true }, target: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: 'typed into ' + (value.target || 'element') }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_type', '输入文本：' + JSON.stringify(args.text) + '（目标 ' + (args.ref || args.selector || '?') + '）')
      return withClient(cfg, async (client) => {
        const point = await resolvePoint(client, args)
        await mouseClick(client, point.x, point.y) // 点击聚焦
        await typeText(client, args.text)
        return { typed: String(args.text), target: args.ref || args.selector || '' }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_extract',
    description: '抽取元素/页面文本；input/textarea/select 返回 value，其余返回 innerText。默认取 body。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      selector: { type: 'string', description: 'CSS 选择器；省略取 body。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true }, count: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector : 'body'
        const expr =
          '(() => { const els = [...document.querySelectorAll(' + JSON.stringify(selector) + ')]; ' +
          'const read = (el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") ' +
          '  ? (el.value ?? "") : (el.innerText ?? el.textContent ?? ""); ' +
          'if (els.length === 0) return null; ' +
          'return { text: els.map(read).join("\\n"), count: els.length }; })()'
        const result = await evaluate(client, expr)
        if (result === null || result === undefined) return { text: '', count: 0 }
        return { text: typeof result.text === 'string' ? result.text : '', count: Number(result.count) || 0 }
      }, args.targetId)
    },
  })))

  // ===== 导航历史 =====
  const mountNav = (name, description, action, renderText) => {
    disposers.push(ctx.tools.register(defineTool({
      name,
      description,
      parameters: { ...TARGET_ID_SCHEMA },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { navigated: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: renderText }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        return withClient(cfg, async (client) => { await action(client); return { navigated: true } }, args.targetId)
      },
    })))
  }
  mountNav('browser_navigate_back', '后退到上一页（等价浏览器「后退」按钮）。', goBack, 'navigated back')
  mountNav('browser_navigate_forward', '前进到下一页（等价浏览器「前进」按钮）。', goForward, 'navigated forward')
  mountNav('browser_reload', '刷新当前页。', reload, 'reloaded')

  // ===== Tab 管理 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_new_page',
    description: '新建标签页并（可选）导航到 URL。返回新标签页 id，供其它工具的 targetId 参数使用。',
    parameters: { url: { type: 'string', description: '初始 URL；省略新建 about:blank 空白页。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, url: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'new page ' + value.id + (value.url && value.url !== 'about:blank' ? ' -> ' + value.url : '') }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const url = typeof args.url === 'string' && args.url.trim() !== '' ? args.url : 'about:blank'
      const t = await createTarget(cfg.cdpEndpoint, url)
      return { id: t.id || '', url: t.url || url }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_close_page',
    description: '关闭指定标签页（id 来自 browser_pages 或 browser_new_page）。',
    parameters: { targetId: { type: 'string', required: true, description: '要关闭的标签页 id。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'closed page' }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await closeTarget(cfg.cdpEndpoint, args.targetId)
      closeSession(args.targetId)
      return { closed: true }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_select_page',
    description: '把指定标签页提到前台（headed 模式下让人类看到该标签页）。',
    parameters: { targetId: { type: 'string', required: true, description: '要激活的标签页 id。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { active: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'activated page' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await activateTarget(cfg.cdpEndpoint, args.targetId)
      return { active: true }
    },
  })))

  // ===== 元素操作 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: '清空并填入表单字段（input/textarea），派发 input/change 事件让 React/Vue 等框架感知。与 browser_type（模拟按键）不同：fill 直接设值。敏感动作。',
    parameters: { ...TARGET_ID_SCHEMA, ...TARGET_SCHEMA, text: { type: 'string', required: true, description: '要填入的文本。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { filled: { type: 'boolean', required: true }, target: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: 'filled ' + (value.target || 'field') }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_fill', '填表：' + JSON.stringify(args.text))
      return withClient(cfg, async (client) => {
        await fillValue(client, args, String(args.text))
        return { filled: true, target: args.ref || args.selector || '' }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_select_option',
    description: '选择原生 <select> 下拉框的选项（按 option 的 value 或可见文本匹配）。敏感动作。',
    parameters: { ...TARGET_ID_SCHEMA, ...TARGET_SCHEMA, value: { type: 'string', required: true, description: '选项的 value 属性或可见文本。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { selected: { type: 'string', required: true }, target: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: 'selected "' + value.selected + '"' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_select_option', '下拉选择：' + String(args.value))
      return withClient(cfg, async (client) => {
        await selectOption(client, args, String(args.value))
        return { selected: String(args.value), target: args.ref || args.selector || '' }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_hover',
    description: '把鼠标移到元素上（触发 hover 状态/下拉菜单），不点击。',
    parameters: { ...TARGET_ID_SCHEMA, ...TARGET_SCHEMA },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hovered: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'hovered' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => { await hover(client, args); return { hovered: true } }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: '滚动页面：给 ref/selector 则把该元素滚动到可视区；否则按 delta_y/delta_x 滚轮滚动整页。',
    parameters: { ...TARGET_ID_SCHEMA, ...TARGET_SCHEMA, delta_y: { type: 'integer', description: '纵向滚轮量（正=向下）。' }, delta_x: { type: 'integer', description: '横向滚轮量。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { scrolled: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'scrolled' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const target = (args.ref || args.selector) ? args : undefined
        await scroll(client, target, args.delta_y || 0, args.delta_x || 0)
        return { scrolled: true }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_press_key',
    description: '触发按键（Enter/Tab/Escape/方向键/Backspace 等通用键或单字符），可选 ctrl/alt/meta/shift 修饰。敏感动作。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      key: { type: 'string', required: true, description: '按键名：Enter、Tab、Escape、ArrowDown/Up/Left/Right、Backspace、Delete、Home、End、PageDown/PageUp、F5、Space，或单个字符。' },
      ctrl: { type: 'boolean', description: '是否按 Ctrl（Windows/Linux）。' },
      meta: { type: 'boolean', description: '是否按 Meta/Cmd（macOS）。' },
      alt: { type: 'boolean', description: '是否按 Alt。' },
      shift: { type: 'boolean', description: '是否按 Shift。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'pressed ' + value.pressed }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_press_key', '按键：' + String(args.key))
      return withClient(cfg, async (client) => {
        await pressKey(client, args.key, { ctrl: args.ctrl, meta: args.meta, alt: args.alt, shift: args.shift })
        return { pressed: String(args.key) }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_drag',
    description: '从一个元素拖拽到另一个元素（滑块/自定义拖拽 UI）。原生 HTML5 dragstart/drop 未覆盖。敏感动作。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      from_ref: { type: 'string', description: '起点 ref（形如 @N）。' },
      from_selector: { type: 'string', description: '起点 CSS 选择器。' },
      to_ref: { type: 'string', description: '终点 ref（形如 @N）。' },
      to_selector: { type: 'string', description: '终点 CSS 选择器。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { dragged: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'dragged' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const from = { ref: args.from_ref, selector: args.from_selector }
      const to = { ref: args.to_ref, selector: args.to_selector }
      if (!from.ref && !from.selector && !to.ref && !to.selector) throw new Error('browser_drag 需要 from_ref/from_selector 与 to_ref/to_selector 至少各一')
      await gate(ctx, cfg, exec, 'browser_drag', '拖拽')
      return withClient(cfg, async (client) => {
        await drag(client, from, to)
        return { dragged: true }
      }, args.targetId)
    },
  })))

  // ===== 等待 / 求值 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: '等待某个 CSS selector 出现，或页面出现指定文本；超时报错（默认 5s）。适合「点完等结果渲染」。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      selector: { type: 'string', description: '等待出现的 CSS 选择器。' },
      text: { type: 'string', description: '等待出现的页面文本。' },
      timeout_ms: { type: 'integer', description: '超时毫秒，默认 5000。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'waited (found ' + value.found + ')' }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return withClient(cfg, async (client) => {
        return waitFor(client, { selector: args.selector, text: args.text, timeoutMs: args.timeout_ms })
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: '在当前页执行 JS 表达式并回传返回值（JSON 值）。用于抽取复杂 DOM 状态/数据。敏感动作（可改动页面）。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      expression: { type: 'string', required: true, description: '要执行的 JS 表达式（返回可 JSON 序列化的值）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { value: { type: 'json', required: true } } },
      render: (_args, value) => [{ type: 'text', text: typeof value.value === 'string' ? value.value : JSON.stringify(value.value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_evaluate', 'JS 求值')
      return withClient(cfg, async (client) => {
        const value = await evaluate(client, String(args.expression))
        return { value: value === undefined ? null : value }
      }, args.targetId)
    },
  })))

  // ===== 对话框 / 文件 / 会话 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_handle_dialog',
    description: '接受/拒绝当前打开的 JS 对话框（alert/confirm/prompt）。prompt 可用 prompt_text 填空。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      accept: { type: 'boolean', description: 'true=确定，false=取消。默认 true。' },
      prompt_text: { type: 'string', description: 'prompt 对话框要填入的文本。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { handled: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'handled dialog' }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return withClient(cfg, async (client) => handleDialog(client, args.accept !== false, args.prompt_text), args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_file_upload',
    description: '给 <input type=file> 设置本地文件（绝对路径数组）触发上传。敏感动作。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      ...TARGET_SCHEMA,
      file_paths: { type: 'array', items: { type: 'string' }, required: true, description: '本地绝对文件路径数组。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { uploaded: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'uploaded ' + value.uploaded + ' file(s)' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await gate(ctx, cfg, exec, 'browser_file_upload', '上传文件：' + JSON.stringify((args.file_paths || []).slice(0, 8)))
      return withClient(cfg, async (client) => setFiles(client, args, (args.file_paths || []).map(String)), args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_cookies',
    description: '列出当前 cookies（名称/域/路径/过期，值一律打码不回传，避免泄露会话凭证）。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      urls: { type: 'array', items: { type: 'string' }, description: '限定 URL 列表；省略=全部。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cookies: { type: 'array', items: { type: 'json' }, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.cookies.length === 0
          ? '(no cookies)'
          : value.cookies.map((c) => '- ' + c.name + ' @ ' + c.domain + ' (' + (c.path || '/') + ')' + (c.session ? ' [session]' : '')).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const cookies = await getCookies(client, args.urls)
        return {
          cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, session: Boolean(c.session), expires: c.expires || 0 })),
        }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_delete_cookies',
    description: '删除 cookie：给 name 删指定 cookie，省略 name 清除全部（可加 url 限定域，相当于登出）。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      name: { type: 'string', description: 'cookie 名；省略删全部。' },
      url: { type: 'string', description: '限定的 URL。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'deleted cookies' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        await deleteCookies(client, args.name, args.url)
        return { deleted: true }
      }, args.targetId)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_storage',
    description: '读写浏览器存储 localStorage/sessionStorage：action=get/set/remove，key 为键，value 为 set 的值（字符串）。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      action: { type: 'string', required: true, description: 'get / set / remove。' },
      kind: { type: 'string', required: true, description: 'local 或 session。' },
      key: { type: 'string', required: true, description: '键名。' },
      value: { type: 'string', description: 'set 时要写入的值。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, value: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: value.value === undefined ? 'storage ok' : JSON.stringify(value.value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const kind = String(args.kind) === 'session' ? 'sessionStorage' : 'localStorage'
        const key = JSON.stringify(String(args.key))
        if (args.action === 'get') {
          const v = await evaluate(client, 'window[' + JSON.stringify(kind) + '].getItem(' + key + ')')
          return { ok: true, value: v === undefined ? null : v }
        }
        if (args.action === 'set') {
          await evaluate(client, 'window[' + JSON.stringify(kind) + '].setItem(' + key + ', ' + JSON.stringify(String(args.value ?? '')) + ')')
          return { ok: true }
        }
        if (args.action === 'remove') {
          await evaluate(client, 'window[' + JSON.stringify(kind) + '].removeItem(' + key + ')')
          return { ok: true }
        }
        throw new Error('browser_storage: action 必须是 get/set/remove')
      }, args.targetId)
    },
  })))

  // ===== 观测：console / network（依赖持久连接缓冲，跨 tool call 累积）=====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_console_messages',
    description: '返回本页自连接以来累积的控制台日志（console.log/error/warn 等，跨 tool call 累积）。',
    parameters: { ...TARGET_ID_SCHEMA, limit: { type: 'integer', description: '最多返回条数，默认 50。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { messages: { type: 'array', items: { type: 'json' }, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0 ? '(no console messages)' : value.messages.map((m) => '[' + m.type + '] ' + m.text).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const entry = await withBrowser(cfg, args.targetId)
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50
      return { messages: entry.console.slice(-limit) }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_network_requests',
    description: '返回本页自连接以来累积的网络请求（url/method/status，跨 tool call 累积）。',
    parameters: { ...TARGET_ID_SCHEMA, limit: { type: 'integer', description: '最多返回条数，默认 50。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { requests: { type: 'array', items: { type: 'json' }, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.requests.length === 0 ? '(no network requests)' : value.requests.map((r) => r.method + ' ' + r.status + ' ' + r.url).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const entry = await withBrowser(cfg, args.targetId)
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50
      return { requests: entry.network.slice(-limit) }
    },
  })))

  // ===== 截图兜底（P0.5）：截屏落盘返回路径；像素不进上下文，交给 modlens_read_image 等读 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: '截取当前页为 PNG 存盘，返回绝对路径。图片本身不回传（纯文本模型读不了像素），' +
      '请用 modlens_read_image / read_image 等视觉能力读该路径得到 OCR/描述。适合 a11y 快照覆盖不到的 canvas/图表。',
    parameters: {
      ...TARGET_ID_SCHEMA,
      full_page: { type: 'boolean', description: 'true=整页截图，false=只截当前视口。默认 false。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, bytes: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'screenshot saved: ' + value.path }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return withClient(cfg, async (client) => {
        const res = await client.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: args.full_page === true,
        })
        const dir = resolveScreenshotDir(cfg)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'shot-' + Date.now() + '.png')
        writeFileSync(path, Buffer.from(res.data, 'base64'))
        return { path, bytes: Buffer.byteLength(res.data, 'base64') }
      }, args.targetId)
    },
  })))

  // ===== 自启 Chrome：autoLaunch 已自动，也可以显式调 =====
  disposers.push(ctx.tools.register(defineTool({
    name: 'browser_launch',
    description: '启动带调试端口的 Chrome（独立 profile，登录态常驻）。autoLaunch 默认开启，端点不在时浏览器工具会自动拉起；也可显式调它。',
    parameters: {
      headless: { type: 'boolean', description: '无头模式（默认按 config.headless，通常 false=有窗口）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          already: { type: 'boolean', required: true },
          pid: { type: 'integer' },
          endpoint: { type: 'string', required: true },
          profile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.already
          ? 'chromium already running @ ' + value.endpoint
          : 'chromium launched (pid ' + value.pid + ') @ ' + value.endpoint + '，profile ' + value.profile,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const headless = args.headless !== undefined ? args.headless : cfg.headless
      const r = await launchChrome(cfg, { headless })
      return { already: Boolean(r.already), pid: r.already ? null : r.pid, endpoint: r.endpoint, profile: r.profile }
    },
  })))

  return () => {
    closeAll()
    for (const dispose of disposers) {
      try { dispose() } catch { /* 忽略卸载失败 */ }
    }
  }
}