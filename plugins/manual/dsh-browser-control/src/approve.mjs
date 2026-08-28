// 敏感动作（click / type）的人工审批：走 userQuestions.ask —— 只有 live runtime root 能问人，
// 被 subagent 拥有的 agent 会被 DELEGATED_CALLER 拒绝（fail-closed）。
// 机制事实见 knowledge/foundations/tool-approval-interception-and-secrets.md；
// 人不可达、拒绝或异常时一律 fail-closed。

const OPTIONS = [
  { label: '允许一次', description: '仅放行这一次浏览器动作。' },
  { label: '拒绝', description: '不放行，动作不执行。' },
]

/**
 * @param {object} ctx cordis 上下文
 * @param {{ agent: object, tool: string, detail: string }} o
 * @returns {Promise<{ verdict: 'once'|'denied', reason?: string, note?: string }>}
 */
export async function requestActionApproval(ctx, { agent, tool, detail }) {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) {
    return { verdict: 'denied', reason: '审批不可用（无 userQuestions 服务），动作已拒绝' }
  }
  try {
    const answer = await questions.ask({
      agent,
      questions: [
        {
          id: 'browser-action-approve',
          header: '浏览器动作审批',
          question: '是否允许执行浏览器动作「' + tool + '」？',
          detail,
          options: OPTIONS,
        },
      ],
    })
    const item = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
    const selected = item && Array.isArray(item.selected) ? item.selected : []
    const custom = item && typeof item.custom === 'string' ? item.custom.trim() : ''
    if (selected.includes('允许一次')) return { verdict: 'once', note: custom || undefined }
    // 未选任何「允许」项 → fail-closed 拒绝。
    return { verdict: 'denied', reason: custom || '操作员选择拒绝' }
  } catch (error) {
    // 人不可达（DELEGATED_CALLER / CALLER_NOT_LIVE）、中止、或无 provider：一律按拒绝。
    return {
      verdict: 'denied',
      reason: '审批失败/不可用，动作已拒绝: ' + String(error && error.message ? error.message : error),
    }
  }
}
