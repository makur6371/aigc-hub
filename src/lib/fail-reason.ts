import { friendlyLlmError } from './friendly-llm-error'

/**
 * 把后端/上游的原始报错翻成**用户能看懂、能行动**的一句话。
 *
 * 为什么放在 lib 而不是前端 store：这是纯业务语义的翻译规则（内容审核 / 素材过期 /
 * 配额），前后端都用得上（例如 API 层想在写日志前先归一化文案），
 * 埋在某个前端 store 里会让服务端拿不到、也让「同一句话有多套说法」有机可乘。
 *
 * 与 lib/network-error.ts 的分工：
 *   - network-error：**网络层**故障（DNS / 超时 / 连接重置）→ 带机器码
 *   - 本文件：**上游业务返回**的失败（内容审核 / 素材过期 / 配额不足）
 *   两者互补，不重叠。
 *
 * 只做**分类 + 给动作**，不篡改事实：认不出来的错误保留原文
 * （宁可啰嗦，也不能编一个原因误导用户）。
 */
export function humanizeFailReason(raw: string): string {
  const t = (raw || '').toLowerCase()
  if (!t) return ''

  // 1) 上游内容审核（实测高频：9/18 一天 55 次「与第三方内容相似性」）
  if (raw.includes('相似性') || t.includes('similarity')) {
    return '内容审核未通过：与已有内容过于相似。请更换参考图或调整描述后重试。'
  }
  if (raw.includes('非法或违法') || raw.includes('内容政策') || t.includes('content policy')) {
    return '内容审核未通过：触发了平台的合规限制。请调整素材或描述后重试。'
  }
  // 2) 参考图过期（上传素材只保留 2 小时）
  if (raw.includes('参考图已过期') || t.includes('image_url fetch failed')) {
    return '参考图已过期：上传的素材只保留 2 小时，请重新上传图片后再试。'
  }
  // 3) 上游偶发故障 / 网络问题（重试即可）
  if (t.includes('openai_error') || t.includes('upstream_error')) {
    return '上游服务临时异常，稍后重试即可（重试通常就能成功）。'
  }
  if (t.includes('fetch failed') || t.includes('econnreset') || t.includes('network')) {
    return '网络连接中断，请重试。'
  }
  if (t.includes('aborted') || raw.includes('超时') || t.includes('timeout')) {
    return '请求超时（多出现在大尺寸出图），请重试或降低清晰度档位。'
  }
  const llmHint = friendlyLlmError(raw)
  if (llmHint !== raw) return llmHint
  // 4) 配额/余额类
  if (raw.includes('积分不足') || t.includes('insufficient')) {
    return '积分不足，请充值后再试。'
  }
  // 认不出来：保留原文，不编原因
  return raw
}
