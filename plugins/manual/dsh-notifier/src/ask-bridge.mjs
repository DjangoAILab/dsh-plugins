// dsh-notifier ask-bridge.mjs
// 桥接 ask_user_question（human-call 提醒）：ctx.userQuestions.ask 被调用时主动推一条通知。
//
// 背景（为什么不能用事件监听）：ask_user_question 走 @deepseek-ai/dsh-user-questions 的
// UserQuestionService.ask()，它是「单 UI provider + 不发射任何 session 事件」——插件层
// 无法通过 ctx.on 感知提问。唯一可行入口是包装 ctx.userQuestions.ask()：在委托原 provider
// 之前推一条通知（尽力而为，绝不 throw，不打断提问本体）。
//
// 设计边界：
//  - 只做「通知」（提醒人去 Web 回答），不做「远程回答」（选项卡片/编号回复是 0.8.0 规划）；
//  - 通知走 notifier.notifyAll → 出站渠道（飞书群 webhook 等），与 turn/end、approval/asked
//    同一推送线；未配出站渠道时静默无操作（与既有 notify 语义一致）。

/** 从提问请求里抽取可读摘要（首问文本 + 选项）。 */
function summarizeQuestions(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0] ?? {}
  const qText = typeof first.question === 'string' && first.question.trim() !== ''
    ? first.question.trim()
    : (typeof first.id === 'string' && first.id !== '' ? first.id : '')
  const options = Array.isArray(first.options) ? first.options : []
  const labels = options
    .map((o) => (o !== null && typeof o === 'object' && typeof o.label === 'string' ? o.label : ''))
    .filter((s) => s !== '')
  const optionText = labels.length > 0 ? `\n选项：${labels.join(' / ')}` : ''
  const content = qText !== '' ? qText + optionText : '（请到 Web 查看并回答）'
  return { title: '🔔 需要你回答', content, count: questions.length }
}

/**
 * 包装 ctx.userQuestions.ask，提问时推通知。
 * @param ctx - cordis 上下文
 * @param notifier - createNotifier 返回值（{ notifyAll }）
 * @param {{ logger?: object }} [options]
 * @returns {() => void} 注销器（恢复原 ask 方法）
 */
export function registerAskBridge(ctx, notifier, options = {}) {
  let userQuestions
  try {
    userQuestions = (typeof ctx?.get === 'function' ? ctx.get('userQuestions') : undefined) ?? ctx?.userQuestions
  } catch {
    userQuestions = undefined
  }
  if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== 'function') {
    // 宿主没有 userQuestions 服务：静默跳过（绝不弄崩启动）
    return () => {}
  }
  if (userQuestions.__dshNotifierWrapped === true) return () => {}

  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/ask]', message) } catch { /* 日志失败不致命 */ }
  }

  userQuestions.__dshNotifierWrapped = true
  const originalAsk = userQuestions.ask.bind(userQuestions)
  const wrappedAsk = async function (request) {
    // 先推通知（尽力而为；失败只 warn，绝不 throw，不打断提问）
    try {
      const summary = summarizeQuestions(request)
      await notifier.notifyAll({ title: summary.title, content: summary.content, level: 'timeSensitive' })
    } catch (error) {
      warn(`ask 通知推送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    return originalAsk(request)
  }
  userQuestions.ask = wrappedAsk

  return () => {
    try {
      if (userQuestions.ask === wrappedAsk) userQuestions.ask = originalAsk
      delete userQuestions.__dshNotifierWrapped
    } catch { /* 恢复失败不致命 */ }
  }
}
