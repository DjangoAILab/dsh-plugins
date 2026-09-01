// DOM 快照渲染（纯函数，可单测）：把 CDP Accessibility.getFullAXTree 返回的扁平
// AXNode 列表，还原成按父子关系缩进的可读树。ref（@N）只分配给**可交互角色**
// （button/link/textbox/…，见 INTERACTIVE_ROLES），静态内容（StaticText/heading/image…）
// 只渲染不编号——ref 序号更少更稳，供 browser_click / browser_type 精确命中。
//
// 观察模态选「结构化 a11y 快照优先」而非截图，理由见
// knowledge/domains/computer-use/observation-control-taxonomy.md（token 便宜 + 确定性高）。

// 可交互角色白名单：只有这些角色拿 ref（角色名按 CDP Accessibility.AXRole 的小写形式）。
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio',
  'slider', 'spinbutton', 'switch', 'tab', 'tablist', 'tree', 'treeitem',
  'textarea', 'menubar', 'toolbar', 'meter', 'progressbar',
])

export function isInteractiveRole(role) {
  return INTERACTIVE_ROLES.has(role)
}

function valueOf(prop) {
  if (prop === undefined || prop === null) return ''
  const v = prop.value
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function roleLabel(node) {
  const role = valueOf(node.role)
  const name = valueOf(node.name)
  const value = valueOf(node.value)
  const parts = [role]
  if (name !== '') parts.push('"' + name + '"')
  if (value !== '') parts.push('=' + value)
  return parts.join(' ')
}

function indent(depth) {
  return '  '.repeat(Math.max(0, depth))
}

/**
 * @param {Array<object>} nodes 扁平 AXNode 列表（含 nodeId / ignored / role / name / value / backendDOMNodeId / childIds / parentId）
 * @returns {{ text: string, refs: Map<string, number>, refsMeta: Map<string, {role: string, name: string}> }}
 *   text 为可读快照；refs 把 "1".."N" 映射到 backendDOMNodeId（仅可交互角色）；
 *   refsMeta 记录每个 ref 的 { role, name }（快照时的语义，供诊断/比对）。
 */
export function renderAccessibilityTree(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { text: '(empty accessibility tree)', refs: new Map(), refsMeta: new Map() }
  }

  const byId = new Map()
  for (const n of nodes) {
    if (n && typeof n.nodeId === 'string') byId.set(n.nodeId, n)
  }

  const roots = nodes.filter((n) => !n || n.parentId === undefined || !byId.has(n.parentId))

  const refs = new Map()
  const refsMeta = new Map()
  const lines = []
  let counter = 0

  function walk(node, depth) {
    if (!node) return
    if (node.ignored !== true) {
      const role = valueOf(node.role)
      const name = valueOf(node.name)
      // StaticText 直接并入该行文本展示（少一行包装，快照更紧凑）。
      if (role === 'StaticText') {
        lines.push(indent(depth) + '- ' + (name !== '' ? name : roleLabel(node)))
      } else {
        let suffix = ''
        // ref 只给可交互角色；是否有 backendDOMNodeId 不再影响编号资格。
        if (node.backendDOMNodeId !== undefined && node.backendDOMNodeId !== null && isInteractiveRole(role)) {
          counter += 1
          refs.set(String(counter), node.backendDOMNodeId)
          refsMeta.set(String(counter), { role, name })
          suffix = ' [ref=@' + counter + ']'
        }
        lines.push(indent(depth) + '- ' + roleLabel(node) + suffix)
      }
    }
    const childDepth = node.ignored === true ? depth : depth + 1
    for (const childId of node.childIds || []) {
      walk(byId.get(childId), childDepth)
    }
  }

  for (const root of roots) walk(root, 0)

  return { text: lines.join('\n'), refs, refsMeta }
}
