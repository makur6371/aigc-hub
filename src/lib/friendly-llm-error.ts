/**
 * 把 LLM 上游的原始报错翻译成用户能采取行动的话。
 * 只做展示层提示，错误仍保留原文，避免排查时丢信息。
 */
export function friendlyLlmError(message: string): string {
  const raw = (message || '').toLowerCase()
  if (/413|payload too large|request entity too large|too large|图片.{0,6}(过大|太大|尺寸)|too many (images|files)|image.{0,12}(size|large)|超过.{0,6}(大小|张数)|token.{0,12}(limit|length)|context.{0,12}(length|window)/.test(raw)) {
    return `${message}（可能是上传的图片过大或张数过多，请压缩图片、减少张数，或切换其他模型后重试）`
  }
  if (/timeout|timed out|503|502|504|unavailable|rate.?limit|429|upstream|连接失败|服务不可用|aborted/.test(raw)) {
    return `${message}（上游模型暂时不可用，请稍后重试或切换其他模型）`
  }
  return message
}
