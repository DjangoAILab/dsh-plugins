// snapshot.mjs — AX 树 → 文本快照渲染（与 browser_snapshot 的 a11y 树体验同构）。
//
// 输出两段：①树形文本（ref + role + name/value 摘要，模型据此选元素）；
//          ②机器 JSON（nodes 数组，动作阶段按 ref 解析路径用）。

function frameText(frame) {
  if (!frame || typeof frame !== 'object') return ''
  const r = (n) => Math.round(Number(n) || 0)
  return `(${r(frame.x)},${r(frame.y)}) ${r(frame.width)}x${r(frame.height)}`
}

/** 单节点一行：ref、缩进、role、标题/值/描述。 */
export function renderNodeLine(node) {
  const depth = Number(node.depth) || 0
  const indent = '  '.repeat(depth)
  const role = node.role || '?'
  const label = node.title || (node.value ?? '')
  const desc = node.description ? ' "' + node.description + '"' : ''
  const actions = Array.isArray(node.actions) && node.actions.length
    ? ' [' + node.actions.join(',') + ']'
    : ''
  const focus = node.focused === true ? ' *FOCUSED*' : ''
  const valueText =
    node.value !== undefined && node.value !== null && typeof node.value !== 'object'
      ? ' value=' + JSON.stringify(String(node.value).slice(0, 80))
      : ''
  const titleText = typeof label === 'string' && label !== '' ? ' ' + JSON.stringify(label.slice(0, 80)) : ''
  return `${indent}- ${node.ref} ${role}${titleText}${valueText}${desc}${actions}${focus}`
}

/**
 * 渲染 snapshot 结果为模型可读文本。
 * @param {object} result driver snapshot 应答（nodes/nodeCount/...）
 * @returns {string[]}
 */
export function renderSnapshotLines(result) {
  const lines = []
  const title = result.title ? JSON.stringify(result.title) : '(untitled window)'
  lines.push(`window ${result.windowIndex ?? 0}/${result.windowCount ?? 1} of pid=${result.pid} — ${title}` +
    (result.frame ? '  ' + frameText(result.frame) : ''))
  const nodes = Array.isArray(result.nodes) ? result.nodes : []
  if (nodes.length === 0) {
    lines.push('(empty AX tree — app 未暴露辅助功能树；Electron/Chromium 类见 computer_doctor 指引)')
    return lines
  }
  for (const node of nodes) lines.push(renderNodeLine(node))
  if (result.truncatedNodes > 0) {
    lines.push(`… ${result.truncatedNodes} nodes truncated (maxDepth/maxNodes 封顶；用 maxNodes/maxDepth 参数放宽)`)
  }
  return lines
}

/** listApps 的文本渲染。 */
export function renderAppsLines(apps) {
  if (!Array.isArray(apps) || apps.length === 0) return ['(no regular GUI apps running)']
  return apps.map((a) => {
    const ax = a.axWindows === null || a.axWindows === undefined ? 'ax=?' : 'axWin=' + a.axWindows
    const front = a.frontmost ? ' [frontmost]' : ''
    const hidden = a.hidden ? ' [hidden]' : ''
    return `- pid=${a.pid} ${a.name}${a.bundleId ? '  ' + a.bundleId : ''}  ${ax}${front}${hidden}`
  })
}

/** listWindows 的文本渲染。 */
export function renderWindowsLines(result) {
  if (result.hint) return ['(no readable windows) ' + result.hint]
  const wins = Array.isArray(result.windows) ? result.windows : []
  if (wins.length === 0) return ['(no windows)']
  return wins.map((w) => {
    const flags =
      (w.minimized === true ? ' [minimized]' : '') + (w.main === true ? ' [main]' : '')
    return `- ${w.ref} ${JSON.stringify(w.title ?? '(untitled)')}  ${frameText(w.frame)}${flags}`
  })
}
