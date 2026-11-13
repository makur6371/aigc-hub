// chat 响应与流式解析归一化（声明式，基于 ResponseSpec / 默认 OpenAI 形态）。
// 目标：所有厂商统一产出内部标准 { content, reasoning, usage, finishReason }。
import type { AdapterChatResponse, AdapterChatStreamChunk, AdapterToolCall, AdapterToolCallDelta, AdapterTokenUsage, ChatResponseSpec, JsonPath, StatusShape } from '@/types'

/** 安全沿 JSON 路径取值。path 形如 ['choices', 0, 'message', 'content'] */
export function jsonGet(obj: unknown, path: JsonPath | undefined): unknown {
  if (path === undefined) return undefined
  let cur: unknown = obj
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur === 'object') {
      cur = (cur as Record<string | number, unknown>)[seg]
    } else {
      return undefined
    }
    if (cur === undefined) return undefined
  }
  return cur
}

function pickUsage(body: unknown, spec: ChatResponseSpec['usage']): AdapterTokenUsage | undefined {
  if (!spec?.path) return undefined
  const u = jsonGet(body, spec.path)
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, unknown>
  const read = (key?: string): number | undefined => {
    if (!key) return undefined
    const v = Number(o[key])
    return Number.isNaN(v) ? undefined : v
  }
  const usage: AdapterTokenUsage = {}
  const p = read(spec.promptTokens)
  const c = read(spec.completionTokens)
  const r = read(spec.reasoningTokens)
  const t = read(spec.totalTokens)
  if (p !== undefined) usage.promptTokens = p
  if (c !== undefined) usage.completionTokens = c
  if (r !== undefined) usage.reasoningTokens = r
  if (t !== undefined) usage.totalTokens = t
  // 无 total 时尽量推算
  if (t === undefined && (p !== undefined || c !== undefined || r !== undefined)) {
    usage.totalTokens = (p || 0) + (c || 0) + (r || 0)
  }
  return usage
}

/**
 * 非流式响应归一化。content 支持两种形态：
 *  - contentPath：直接路径。
 *  - contentBlocks：块数组（Claude），取 type==='text' 拼接。
 * finishMap 把厂商终止码映射回内部语义（不映射则透传原文）。
 */
export function parseChatResponseFromSpec(body: unknown, spec: ChatResponseSpec): AdapterChatResponse {
  let content = ''
  if (spec.contentBlocks) {
    const blocks = jsonGet(body, [spec.contentBlocks.field]) as Record<string, unknown>[] | undefined
    if (Array.isArray(blocks)) {
      const typeKey = spec.contentBlocks.typeKey || 'type'
      const textKey = spec.contentBlocks.textKey || 'text'
      const textType = spec.contentBlocks.textType || 'text'
      content = blocks
        .filter((b) => b[typeKey] === textType)
        .map((b) => String(b[textKey] ?? ''))
        .join('')
    }
  } else {
    content = String(jsonGet(body, spec.contentPath) ?? '')
  }

  const reasoningValue =
    jsonGet(body, spec.reasoningPath) !== undefined && jsonGet(body, spec.reasoningPath) !== null
      ? jsonGet(body, spec.reasoningPath)
      : jsonGet(body, spec.reasoningAltPath)
  const reasoning = reasoningValue !== undefined && reasoningValue !== null
    ? String(reasoningValue)
    : undefined

  let finishReason = jsonGet(body, spec.finishReasonPath) !== undefined
    ? String(jsonGet(body, spec.finishReasonPath))
    : 'stop'
  if (spec.finishMap && finishReason in spec.finishMap) {
    finishReason = spec.finishMap[finishReason]
  }

  const usage = pickUsage(body, spec.usage)
  // tool_calls（OpenAI 非流式）：arguments 是 JSON 字符串，原样透出，由调用方容错解析
  const toolCalls = parseToolCalls(jsonGet(body, ['choices', 0, 'message', 'tool_calls']))
  return { content, reasoning, finishReason, usage, ...(toolCalls.length ? { toolCalls } : {}) }
}

/** 归一化完整 tool_calls（非流式响应体） */
export function parseToolCalls(raw: unknown): AdapterToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: AdapterToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const fn = (o.function || {}) as Record<string, unknown>
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (!name) continue
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `call_${out.length}`,
      name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    })
  }
  return out
}

/**
 * 默认流式解析器（OpenAI-delta 形态），供 profile 未提供专属流解析、且声明 stream:'sse' 的厂商使用。
 * 传入 = provider-invoker 切分后的一行 SSI；兼容 `data: {...}` / 裸 JSON / `[DONE]`。
 */
export function parseOpenAIStyleStreamChunk(line: string): AdapterChatStreamChunk | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let payload: string
  if (trimmed.startsWith('data: ')) {
    payload = trimmed.slice(6)
  } else if (trimmed.startsWith('data:')) {
    payload = trimmed.slice(5)
  } else {
    // 非 SSE（可能是裸 JSON/解包后的增量）：尝试直接解析
    payload = trimmed
  }

  if (payload === '[DONE]' || payload.trim() === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as Record<string, unknown>
  const choice = (obj.choices as Record<string, unknown>[] | undefined)?.[0]
  const delta = (choice?.delta || {}) as Record<string, unknown>
  const content = delta.content !== undefined ? String(delta.content) : undefined
  const reasoning =
    delta.reasoning_content !== undefined ? String(delta.reasoning_content)
    : delta.reasoning !== undefined ? String(delta.reasoning)
    : undefined
  const finishReason = choice?.finish_reason !== undefined ? String(choice.finish_reason) : undefined

  // usage（openai 流式末帧可能携带）
  let usage: AdapterTokenUsage | undefined
  if (obj.usage && typeof obj.usage === 'object') {
    const u = obj.usage as Record<string, unknown>
    usage = {}
    if (u.prompt_tokens !== undefined) usage.promptTokens = Number(u.prompt_tokens)
    if (u.completion_tokens !== undefined) usage.completionTokens = Number(u.completion_tokens)
    if (u.total_tokens !== undefined) usage.totalTokens = Number(u.total_tokens)
  }

  // tool_calls 增量：OpenAI 按 index 分片下发，id/name 只在首片出现，arguments 分多片拼接
  const rawToolCalls = delta.tool_calls
  let toolCalls: AdapterToolCallDelta[] | undefined
  if (Array.isArray(rawToolCalls)) {
    toolCalls = []
    for (let i = 0; i < rawToolCalls.length; i++) {
      const tc = rawToolCalls[i] as Record<string, unknown> | null
      if (!tc || typeof tc !== 'object') continue
      const fn = (tc.function || {}) as Record<string, unknown>
      const d: AdapterToolCallDelta = { index: typeof tc.index === 'number' ? tc.index : i }
      if (typeof tc.id === 'string' && tc.id) d.id = tc.id
      if (typeof fn.name === 'string' && fn.name) d.name = fn.name
      if (typeof fn.arguments === 'string') d.argumentsDelta = fn.arguments
      toolCalls.push(d)
    }
    if (toolCalls.length === 0) toolCalls = undefined
  }

  if (content === undefined && reasoning === undefined && !finishReason && !usage && !toolCalls) return null
  const chunk: AdapterChatStreamChunk = {}
  if (content !== undefined) chunk.content = content
  if (reasoning !== undefined) chunk.reasoning = reasoning
  if (finishReason !== undefined) chunk.finishReason = finishReason
  if (usage) chunk.usage = usage
  if (toolCalls) chunk.toolCalls = toolCalls
  return chunk
}

/** 依 StatusShape 归一化异步任务状态（image/video 轮询共用）。 */
export function parseStatusFromShape(
  body: unknown,
  shape: StatusShape | undefined,
  defaultStatus: 'PENDING' | 'SUCCESS' | 'FAILED' = 'PENDING',
): { status: 'PENDING' | 'SUCCESS' | 'FAILED'; value?: string; url?: string; error?: string } {
  const status = shape?.statusPath ? String(jsonGet(body, shape.statusPath) ?? '') : ''
  const url = shape?.urlPath ? String(jsonGet(body, shape.urlPath) ?? '') : undefined
  const rawError = shape?.errorPath ? String(jsonGet(body, shape.errorPath) ?? '') : undefined

  const st = status.toLowerCase()
  const urlValue = url || (url === '' ? undefined : undefined)

  const matchList = (list: (string | RegExp)[] | undefined): boolean => {
    if (!list) return false
    return list.some((x) => (typeof x === 'string' ? x.toLowerCase() === st : x.test(status)))
  }

  if (urlValue || matchList(shape?.completed)) {
    return { status: 'SUCCESS', value: status, url: urlValue }
  }
  if (matchList(shape?.failed)) {
    return { status: 'FAILED', value: status, error: rawError || '上游任务失败' }
  }
  return { status: baseStatus(status) || defaultStatus, value: status, url: urlValue }
}

function baseStatus(status: string): 'PENDING' | 'SUCCESS' | 'FAILED' | undefined {
  const s = status.toLowerCase()
  if (['success', 'succeeded', 'completed', 'finished', 'done'].includes(s)) return 'SUCCESS'
  if (['failed', 'error', 'cancelled', 'canceled'].includes(s)) return 'FAILED'
  return undefined
}
