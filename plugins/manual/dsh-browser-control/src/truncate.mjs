// truncate.mjs — 模型可见输出的统一截断预算。
// snapshot / extract / evaluate 的返回值都直接进模型上下文，超长页面会把上下文撑爆；
// 这里提供唯一的截断原语，超长时截断并追加一行损耗说明（让模型知道有省略）。

/**
 * 超长文本截断：超过 maxChars 时保留前 maxChars 个字符，并追加 '\n…[truncated N of M chars]'
 * （N = 被省略字符数，M = 原始总长）。非字符串输入先 String() 化。
 */
export function truncateText(text, maxChars) {
  const s = typeof text === 'string' ? text : String(text)
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 0
  if (limit <= 0 || s.length <= limit) return s
  const omitted = s.length - limit
  return s.slice(0, limit) + '\n…[truncated ' + omitted + ' of ' + s.length + ' chars]'
}
