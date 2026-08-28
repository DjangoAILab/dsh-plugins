// DOM 快照渲染（纯函数，可单测）：把 CDP Accessibility.getFullAXTree 返回的扁平
// AXNode 列表，还原成按父子关系缩进的可读树，并给每个带 backendDOMNodeId 的非 ignored
// 节点分配稳定 ref（@1..@N）。ref 是「浏览顺序」，供 browser_click / browser_type 精确命中。
//
// 观察模态选「结构化 a11y 快照优先」而非截图，理由见
// knowledge/domains/computer-use/observation-control-taxonomy.md（token 便宜 + 确定性高）。

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
 * @returns {{ text: string, refs: Map<string, number> }} text 为可读快照；refs 把 "1".."N" 映射到 backendDOMNodeId
 */
export function renderAccessibilityTree(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { text: '(empty accessibility tree)', refs: new Map() }
  }

  const byId = new Map()
  for (const n of nodes) {
    if (n && typeof n.nodeId === 'string') byId.set(n.nodeId, n)
  }

  const roots = nodes.filter((n) => !n || n.parentId === undefined || !byId.has(n.parentId))

  const refs = new Map()
  const lines = []
  let counter = 0

  function walk(node, depth) {
    if (!node) return
    if (node.ignored !== true) {
      let suffix = ''
      if (node.backendDOMNodeId !== undefined && node.backendDOMNodeId !== null) {
        counter += 1
        refs.set(String(counter), node.backendDOMNodeId)
        suffix = ' [ref=@' + counter + ']'
      }
      lines.push(indent(depth) + '- ' + roleLabel(node) + suffix)
    }
    const childDepth = node.ignored === true ? depth : depth + 1
    for (const childId of node.childIds || []) {
      walk(byId.get(childId), childDepth)
    }
  }

  for (const root of roots) walk(root, 0)

  return { text: lines.join('\n'), refs }
}