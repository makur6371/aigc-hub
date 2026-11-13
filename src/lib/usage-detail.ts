// ===== 调用详情（请求 / 返回）序列化 =====
//
// 运维面板的「调用记录」要能点开看每次调用发出去什么、收回来什么，否则排查只能靠猜。
// 两个约束：
//   1) 必须脱敏：API Key / Authorization / base64 图片不能进库（既占空间又泄密）；
//   2) 必须截断：提示词可能几千字、返回可能带大段 base64，单条日志不能无限膨胀。

/** 单字段最大长度（字符）。超出截断并标注 */
const MAX_FIELD = 2000
/** 整体最大长度（字符）。超出后直接截断并标注 */
const MAX_TOTAL = 8000

/** 敏感字段名：命中即替换为 ***，避免密钥/令牌落库 */
const SENSITIVE_KEY = /^(authorization|api[-_]?key|apikey|token|secret|password|cookie|set-cookie)$/i

/** 长文本字段：base64 图片等没有排查价值，只留类型和长度 */
function shrinkString(s: string): string {
  if (s.startsWith('data:')) {
    const head = s.slice(0, s.indexOf(',') + 1)
    return `${head}<base64 ${s.length} chars>`
  }
  // 极长的 URL 也可能是 base64 内联，统一按长度截断
  if (s.length > MAX_FIELD) return `${s.slice(0, MAX_FIELD)}…<共 ${s.length} 字符>`
  return s
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<嵌套过深>'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return shrinkString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    // 数组只保留前 20 项（参考图列表等可能很长）
    const head = value.slice(0, 20).map((v) => sanitize(v, depth + 1))
    return value.length > 20 ? [...head, `<还有 ${value.length - 20} 项>`] : head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

/**
 * 把任意对象转成可落库的 JSON 字符串（脱敏 + 截断）。
 * 任何异常都返回 null —— 日志详情不该影响主流程。
 */
export function toDetailJson(value: unknown): string | null {
  if (value === null || value === undefined) return null
  try {
    const s = JSON.stringify(sanitize(value), null, 2)
    if (!s || s === 'null') return null
    return s.length > MAX_TOTAL ? `${s.slice(0, MAX_TOTAL)}\n…<已截断，共 ${s.length} 字符>` : s
  } catch {
    return null
  }
}

/** 从节点 inputs 里挑出有排查价值的字段（避免把整个 inputs 塞进去） */
export function pickRequestDetail(inputs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!inputs) return null
  const keys = [
    'prompt', 'promptSuffix', 'negativePrompt',
    'width', 'height', 'duration', 'aspectRatio',
    'model', 'referenceImage', 'image', 'images',
    'firstFrame', 'lastFrame', 'systemPrompt', 'temperature',
    'text', 'content', 'mode',
  ]
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (inputs[k] !== undefined && inputs[k] !== null && inputs[k] !== '') out[k] = inputs[k]
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 从节点输出里挑出有排查价值的字段 */
export function pickResponseDetail(output: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!output) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(output)) {
    // 跳过纯中间态字段，保留成果与元信息
    if (k === 'cropRegions' || k === 'log') continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : null
}
