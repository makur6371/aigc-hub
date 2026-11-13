/**
 * fetch 失败原因翻译。
 *
 * ===== 为什么需要这个文件 =====
 *
 * Node 的 `fetch`（undici）在**连接层**失败时，抛出的 Error.message 只有一句
 * `fetch failed`，真实原因藏在 `err.cause` 里（`ECONNRESET` / `ETIMEDOUT` /
 * `EAI_AGAIN` / `UND_ERR_SOCKET` …）。
 *
 * 我们的代码以前是直接 `throw err`，于是：
 *   - 运维面板「调用记录」里只显示 `fetch failed`
 *   - 完全无法区分「DNS 解析不了」「连接被重置」「超时」「TLS 失败」
 *   - 排查只能靠翻 nginx 日志反推（2026-09-19 那次就是这么查的）
 *
 * 这个模块把 cause 提取出来，产出**两层信息**：
 *   1. `userMessage` —— 给用户看的中文人话（如「网络连接中断，请重试」）
 *   2. `code`        —— 给运维看的机器码（如 `ECONNRESET`），拼进日志
 *
 * 注意：这里**不做重试、不改流程**，只是把信息补全。错误该怎么抛还怎么抛。
 */

/** undici 网络层错误码 → 用户能看懂的中文 */
const USER_MESSAGE_BY_CODE: Record<string, string> = {
  // 连接被对端/中间设备重置：重启、网关掐断、长连接空闲被回收
  ECONNRESET: '网络连接中断，请重试',
  ECONNREFUSED: '无法连接到服务端，请稍后重试',
  EPIPE: '网络连接中断，请重试',
  // 超时
  ETIMEDOUT: '连接超时，请稍后重试',
  UND_ERR_CONNECT_TIMEOUT: '连接超时，请稍后重试',
  UND_ERR_HEADERS_TIMEOUT: '服务端响应超时，请稍后重试',
  UND_ERR_BODY_TIMEOUT: '服务端响应超时，请稍后重试',
  // DNS
  ENOTFOUND: '域名解析失败（服务端网络异常）',
  EAI_AGAIN: '域名解析超时（服务端网络异常）',
  // socket / TLS
  UND_ERR_SOCKET: '网络连接异常，请重试',
  ECONNABORTED: '网络连接中断，请重试',
  ERR_SSL_WANT_READ: '安全连接异常，请重试',
  CERT_HAS_EXPIRED: '证书已过期（服务端配置问题）',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书校验失败（服务端配置问题）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败（服务端配置问题）',
  // 上游提前关闭
  UND_ERR_RESPONSE_STATUS_CODE: '服务端返回异常',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH': '请求体发送不完整，请重试',
}

/**
 * undici 有些错误**不带 code，只在 cause.message 里写原因**
 * （实测：非法端口是 `bad port`，DNS 失败是 `getaddrinfo ENOTFOUND xxx`）。
 * 所以除了查 code，还要按 message 做一次关键词匹配。
 */
const MESSAGE_RULES: Array<{ match: RegExp; userMessage: string; transient: boolean }> = [
  // ---- Node 20（生产环境的 Node 版本）与 Node 24 的报错文案不同，两边都要覆盖 ----
  //
  // Node 24（本地开发）：超时 → "The operation was aborted due to timeout"（name=TimeoutError）
  // Node 20（生产容器）：超时 → 同上（name=TimeoutError）；主动 abort → "This operation was aborted"
  //
  // 实测生产：connectECONNRESET 时 undici 会**反复重试直到我们自己的超时兜底**，
  // 最终抛出的其实是 abort 错误 —— 所以「超时文案」这条比想象中更常被用到。
  { match: /aborted due to timeout|TimeoutError/i, userMessage: '连接超时，请稍后重试', transient: true },
  { match: /This operation was aborted/i, userMessage: '连接超时或被中断，请重试', transient: true },
  { match: /getaddrinfo|ENOTFOUND|EAI_AGAIN/i, userMessage: '域名解析失败（服务端网络异常）', transient: false },
  { match: /ECONNRESET|socket hang up|other side closed/i, userMessage: '网络连接中断，请重试', transient: true },
  { match: /ECONNREFUSED/i, userMessage: '无法连接到服务端，请稍后重试', transient: true },
  { match: /ETIMEDOUT|timed? ?out/i, userMessage: '连接超时，请稍后重试', transient: true },
  { match: /certificate|self-signed|CERT_|TLS|SSL/i, userMessage: '安全连接异常（服务端配置问题）', transient: false },
  { match: /bad port/i, userMessage: '上游地址配置有误（端口非法）', transient: false },
  { match: /invalid url|URL/i, userMessage: '上游地址格式非法', transient: false },
]

/** 这些码属于「重试就可能好」的瞬时故障（供调用方决定是否重试/是否提示重试） */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'EAI_AGAIN',
])

export interface NetworkFailure {
  /** 机器可读的原始码（写进运维日志用），拿不到时 undefined */
  code?: string
  /** 给用户看的中文说明 */
  userMessage: string
  /** 是否属于「重试可能成功」的瞬时故障 */
  transient: boolean
}

/** 从一个错误对象里挖出 undici 的 cause 信息（可能嵌套；code 和 message 都要） */
function extractCause(err: unknown): { code?: string; message?: string } {
  const seen = new Set<unknown>()
  let cur: unknown = err
  // undici 的 cause 有时还套一层（AggregateError / SocketError），所以循环往下挖
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (seen.has(cur)) break
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && code) return { code }
    // 有些错误没有 code，只有 message（如 "bad port"、"getaddrinfo ENOTFOUND x"）
    const cause = (cur as { cause?: unknown }).cause
    if (cause && typeof cause === 'object') {
      const cCode = (cause as { code?: unknown }).code
      if (typeof cCode === 'string' && cCode) return { code: cCode }
      const cMsg = (cause as { message?: unknown }).message
      if (typeof cMsg === 'string' && cMsg) return { message: cMsg }
    }
    cur = cause
  }
  return {}
}

/**
 * 判断一个错误是不是「网络层失败」（而不是上游返回的业务错误）。
 *
 * 判据：message 是 undici 的通用文案，或能挖到已知的网络错误码。
 * 上游业务错误（如「上游返回错误 (400): ...」「请求频率过高」）不会被误判。
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const { code, message } = extractCause(err)
  if (code && (code in USER_MESSAGE_BY_CODE || code.startsWith('UND_ERR'))) return true
  if (message && MESSAGE_RULES.some((r) => r.match.test(message))) return true
  const msg = err.message || ''
  return (
    /^fetch failed$/i.test(msg.trim()) ||
    /^terminated$/i.test(msg.trim()) ||
    // Node 20/24 的超时与 abort（见 MESSAGE_RULES 注释）：必须算网络故障，
    // 否则会「原样透传」，把 "The operation was aborted due to timeout" 这种
    // 英文技术文案直接甩给用户。
    /aborted due to timeout/i.test(msg) ||
    /^This operation was aborted$/i.test(msg.trim()) ||
    err.name === 'TimeoutError'
  )
}

/**
 * 把一个网络错误翻译成「用户文案 + 机器码」。
 *
 * 非网络错误原样返回其 message（不改变既有行为）。
 */
export function describeNetworkFailure(err: unknown): NetworkFailure {
  const { code, message } = extractCause(err)
  if (code && USER_MESSAGE_BY_CODE[code]) {
    return { code, userMessage: USER_MESSAGE_BY_CODE[code], transient: TRANSIENT_CODES.has(code) }
  }
  // 没有 code（或码未知）时按 cause.message 关键词兜底 —— 实测 undici 的
  // "bad port" / "getaddrinfo ENOTFOUND x" 都属于这一类，只有 message 没有 code。
  if (message) {
    for (const rule of MESSAGE_RULES) {
      if (rule.match.test(message)) {
        return { code, userMessage: rule.userMessage, transient: rule.transient }
      }
    }
  }
  if (code) {
    // 有码但不在表里：保留码（运维可查），用户看通用文案
    return { code, userMessage: '网络异常，请稍后重试', transient: code.startsWith('UND_ERR') }
  }
  // 没有 code（也没有可匹配的 cause.message）时，看 name 与 message。
  // 注意：这里不能直接回退到原 message —— 原 message 可能是
  // "The operation was aborted due to timeout" 这种英文技术文案。
  const nm = err instanceof Error ? err.name : ''
  if (nm === 'TimeoutError') return { code: 'TIMEOUT', userMessage: '连接超时，请稍后重试', transient: true }
  const msg = err instanceof Error ? err.message : ''
  if (/aborted due to timeout/i.test(msg)) return { code: 'TIMEOUT', userMessage: '连接超时，请稍后重试', transient: true }
  if (/^This operation was aborted$/i.test(msg.trim())) return { code: 'ABORTED', userMessage: '连接超时或被中断，请重试', transient: true }
  if (/^terminated$/i.test(msg.trim())) {
    return { code: 'UND_ERR_TERMINATED', userMessage: '连接被中断，请重试', transient: true }
  }
  return { userMessage: msg || '网络异常，请稍后重试', transient: false }
}

/**
 * 给错误信息加上机器码后缀，便于运维定位。
 *
 * 形如：`网络连接中断，请重试 (ECONNRESET)`
 *
 * 为什么要把码暴露在 message 里：运维面板「调用记录」展示的就是 errorMessage，
 * 没有独立的 code 字段可写。把码附在末尾是**改动面最小**的做法，
 * 且用户看到的中文仍然在前半句，不影响理解。
 */
export function withNetworkCode(userMessage: string, code?: string): string {
  if (!code) return userMessage
  // 已有括号说明就不用再加（避免 `中文 (A) (B)`）
  if (userMessage.includes(`(${code})`)) return userMessage
  return `${userMessage} (${code})`
}

/**
 * 把一个网络错误统一包装成 Error（保留中文文案 + 机器码后缀）。
 *
 * 非网络错误原样返回，调用方可以直接 `throw toUpstreamError(err)`。
 */
export function toUpstreamError(err: unknown): Error {
  if (!isNetworkFailure(err)) {
    return err instanceof Error ? err : new Error(String(err))
  }
  const { code, userMessage } = describeNetworkFailure(err)
  return new Error(withNetworkCode(userMessage, code))
}

/**
 * 上游业务错误文案 → 可读中文（针对几家上游把「参考图拉不到」报成晦涩技术错的情况）。
 *
 * 背景：创艺坊等上游在**参考图链接失效/不可访问**时，回的是
 * `invalid base64 image data` —— 这与 base64 毫无关系（我们传的是 URL），
 * 用户和运维看了都一头雾水。这里做一次关键词翻译，指向「参考图/链接」。
 *
 * 只翻译**明确对应**的模式，命中不了原样返回，不影响其它错误文案。
 */
export function humanizeUpstreamMessage(msg: string): string {
  if (!msg) return msg
  if (/invalid base64 image data|base64.*(invalid|decode)|malformed.*base64/i.test(msg)) {
    return '参考图无法读取：链接可能已失效（上游临时链接有效期短）。请换一张可访问的图，或开启该模型「转存到本站」'
  }
  if (/image call .*inspection failed|nova inspection failed/i.test(msg)) {
    return '参考图未通过上游内容审核，请更换素材后重试'
  }
  return msg
}
