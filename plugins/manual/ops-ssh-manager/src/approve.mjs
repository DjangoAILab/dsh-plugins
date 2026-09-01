// Strict-mode approval: block the tool call and ask the human for a decision,
// offering single ("允许一次") and session ("本 session 允许") granularity.
// Returns the verdict; every failure resolves to a denial (fail-closed).

const OPTIONS = [
  { label: '允许一次', description: '仅放行这一次命令执行。' },
  { label: '本 session 允许', description: '本会话内对这台主机的后续命令不再逐条审批。' },
  { label: '拒绝', description: '不放行，命令不会在目标机器执行。' },
]

export async function requestApproval(ctx, { code, alias, command, agent, elevate, includeHost }) {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) {
    return { verdict: 'denied', reason: '审批不可用（无 userQuestions 服务），命令已拒绝' }
  }
  const elevateOnly = elevate && !includeHost
  const title = elevate
    ? `SSH 提权审批（${includeHost ? '严格主机 + ' : ''}将提权 root）`
    : 'SSH 命令审批（严格）'
  const questionText = elevate
    ? `是否允许在「${alias || code}」以 root 提权执行命令？${includeHost ? '（该主机本身也是严格审查级）' : ''}`
    : `是否允许在「${alias || code}」执行命令？`
  const id = elevateOnly ? 'ops-ssh-approve-elevate' : 'ops-ssh-approve'
  try {
    const answer = await questions.ask({
      agent,
      questions: [{
        id,
        header: title,
        question: questionText,
        detail: `代号：${code}\n命令：\n${command}\n\n${elevate ? '⚠️ 本次执行将使用 sudo 提权到 root。\n\n' : ''}可在下方直接输入拒绝原因或备注（未勾选允许项时默认拒绝）。`,
        options: OPTIONS,
      }],
    })
    const item = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
    const selected = item && Array.isArray(item.selected) ? item.selected : []
    const custom = (item && typeof item.custom === 'string' ? item.custom : '').trim()
    // 显式允许优先；同题的备注（custom）随结果带回。
    if (selected.includes('本 session 允许')) return { verdict: 'session', note: custom || undefined }
    if (selected.includes('允许一次')) return { verdict: 'once', note: custom || undefined }
    // 未选任何允许项 → fail-closed 拒绝；自定义输入就是返回给 tool call 结果的拒绝原因。
    return { verdict: 'denied', reason: custom || '操作员选择拒绝' }
  } catch (e) {
    // Unreachable human (DELEGATED_CALLER / CALLER_NOT_LIVE), aborted, or no UI
    // provider: treat as denial.
    return { verdict: 'denied', reason: '审批失败/不可用，命令已拒绝: ' + String(e && e.message ? e.message : e) }
  }
}