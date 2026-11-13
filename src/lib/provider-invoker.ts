import { readFile } from 'node:fs/promises'
import { buildAdapterConfig, getAdapter } from './adapter-runtime'
import { toUpstreamError, humanizeUpstreamMessage } from './network-error'
import { withUpstreamGate } from './concurrency'
import type { AdapterToolCall, AdapterToolCallDelta as ToolCallDelta } from '@/types'
import { checkUrlSafe, safeFetch } from './ssrf-guard'
import { ASSET_DIR, ASSET_URL_PREFIX, fileOfAssetUrl, sniffImageMime, saveAssetFile, expiresAtFor, saveAssetWithRecord } from './asset-store'
import { getPrisma } from './prisma'
import type { RuntimeProviderAdapter } from '@/types'
import type {
  AdapterConfig,
  ChatParams,
  ChatStreamChunk,
  ImageParams,
  TokenUsage,
  VideoParams,
  VideoStatus,
  AudioParams,
  AudioStatus,
} from './adapter-runtime'

/** 上游 provider 连接信息（chat/image/video/audio 共用同一形状） */
type VideoProvider = {
  baseUrl: string
  apiKey: string | null
  adapterId?: string | null
  configJson?: Record<string, unknown> | null
  /** 模型配置的 metadata（含 rehost 转存开关） */
  metadata?: Record<string, unknown> | null
}

const CHAT_TIMEOUT_MS = 60000
// 原 120s 会把长尾请求全部掐断（线上 27 个样本里 9 个 >100s，最慢 123.7s），
// 表现为「一批里有几张莫名失败」。
// 300s → 480s → 900s：4K 档位明显更慢（上游官方文档也写 4K+high 可能超 120s），
// 加上并发排队，8 分钟仍不够稳；15 分钟覆盖最慢的 4K 长尾。
// 与 nginx proxy_read_timeout(1200s) 配合，网关不会再先断。
const IMAGE_TIMEOUT_MS = 900_000
const VIDEO_TIMEOUT_MS = 900_000 // 视频生成超时放宽（慢任务，与生图对齐）
const AUDIO_TIMEOUT_MS = 600_000 // 音频生成超时（音乐/配音通常较快，10 分钟足够）

// 上游直链转存：把厂商返回的临时/外链 URL 服务端下载落盘为本站素材地址。
// 否则 http:// 外链在 https 站点上 <img> 能显示但 fetch 被浏览器拦截（Failed to fetch），
// 且厂商链接过期后成果区全部失效。
//
// 是否转存由**模型配置**决定（metadata.rehost，默认 false = 不转存）：
//   - 不转存：直接用上游 URL。省一次下载 + 一次磁盘写入（高并发下这笔开销不小），
//     代价是厂商链接过期后图片失效——前端会提示「尽快保存」，并提供批量下载。
//   - 转存：落盘为 /api/asset/...，长期可用。
const REHOST_MAX_BYTES = 64 * 1024 * 1024

/** 读取模型的转存开关（metadata.rehost === true 才转存；默认不转存） */
function shouldRehost(metadata?: Record<string, unknown> | null): boolean {
  return metadata?.rehost === true
}
export async function rehostExternalAsset(url: string, userId: string, type: 'image' | 'video' | 'audio'): Promise<string> {
  // 已是本站相对路径（b64 落盘/本站素材），无需转存
  if (url.startsWith('/') || url.startsWith(`${ASSET_URL_PREFIX}/`)) return url
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    // 防 SSRF：上游返回的 URL 也不能盲信（恶意/被劫持的上游可让它指向内网）
    const safe = await checkUrlSafe(url)
    if (!safe.ok) return url
    const controller = new AbortController()
    // 转存是「生成成功后的收尾」，图已经出来了，别让慢下载把它掐成失败。
    // 60s → 120s：大图 / 慢 CDN 场景下 60s 会误杀。
    const timeoutId = setTimeout(() => controller.abort(), 120000)
    try {
      // safeFetch：校验 + 逐跳校验重定向（上游返回的 URL 也不能盲信，见 ssrf-guard）
      const res = await safeFetch(url, { signal: controller.signal })
      if (!res.ok) return url
      const mime = res.headers.get('content-type')?.split(';')[0] || undefined
      // 内容类型与目标类型不符时不转存（避免把错误页存成素材）
      if (mime && !mime.startsWith(`${type}/`)) return url
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength === 0 || buf.byteLength > REHOST_MAX_BYTES) return url
      const saved = await saveAssetFile(userId, buf, { mime, type, source: 'rehost' })
      // 写 user_assets 记录（带 2 小时 TTL）：否则文件成为无记录的孤儿，既不参与清理也占盘
      await getPrisma().then((prisma) =>
        prisma.userAsset.create({
          data: {
            userId,
            type: saved.type,
            url: saved.url,
            fileName: saved.fileName,
            mime: saved.mime,
            size: saved.size,
            source: 'rehost',
            expiresAt: expiresAtFor('rehost'),
          },
        }),
      ).catch(() => { /* 登记失败不影响生成结果，孤儿文件由兜底清理回收 */ })
      return saved.url
    } finally {
      clearTimeout(timeoutId)
    }
  } catch {
    // 转存失败（网络/超时）退回原 URL，不让生成结果因转存而报错
    return url
  }
}

// 统一请求头：优先用 adapter.buildHeaders（厂商自定义鉴权），否则默认 Bearer。
// 注意：buildHeaders 由 adapter 声明，可返回任意键（x-api-key / X-Goog-Api-Key 等），以支持非 OpenAI 兼容厂商。
/**
 * 解析请求头。
 *
 * ⚠️ 已知未接线：profile.auth 的 `api-key-query` 型（key 拼在 URL query 上）目前
 * **不会生效** —— 函数名只处理 header，query 需要调用方拼 `authQueryString()`。
 * 当前生产库没有任何 adapter 用该类型（已核：零命中），所以是潜在缺口而非现网故障。
 * 真要接 query 鉴权网关时：在这里（或各 invoke* 的 endpoint 拼接处）补上
 * `authQueryString(profile.auth, config)`，并加一条联调测试。
 */
function resolveHeaders(adapter: RuntimeProviderAdapter, config: AdapterConfig, extra: Record<string, string> = {}): Record<string, string> {
  let vendor: Record<string, string>
  if (adapter.buildHeaders) {
    vendor = adapter.buildHeaders(config)
  } else {
    vendor = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
  }
  return { 'Content-Type': 'application/json', ...vendor, ...extra }
}

export interface ChatResult {
  content: string
  finishReason: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoning?: string
  /** 模型要求的工具调用（非空表示本轮不是在「回答」而是在「下单动作」） */
  toolCalls?: AdapterToolCall[]
}

export interface VideoResult {
  videoUrl?: string
  taskId?: string
  pollPath?: string
}

export interface AudioResult {
  audioUrl?: string
  taskId?: string
  pollPath?: string
}

export interface ImageResult {
  imageUrl: string
}

/**
 * 统一 chat 入口：与 image/video/audio 一样走并发闸门。
 * 之前这里直接 fetch，导致 LLM 链路（Agent 规划 / Copilot / 工具校验 / OCR / LLM 节点）
 * 完全不受「在途上限 + 派发速率」保护 —— 高并发时能无上限压上游，
 * 而图片链路却被限住，整机稳定性取决于最弱那一环。
 */
export async function invokeChat(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  modelName: string,
  params: ChatParams,
  onChunk?: (text: string) => void,
  onReasoningChunk?: (reasoning: string) => void,
  timeoutMs?: number,
  onToolCallChunk?: (deltas: ToolCallDelta[]) => void,
  userId?: string,
): Promise<ChatResult> {
  return withUpstreamGate(() =>
    invokeChatOnce(provider, modelName, params, onChunk, onReasoningChunk, timeoutMs, onToolCallChunk),
    userId,
  )
}

async function invokeChatOnce(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  modelName: string,
  params: ChatParams,
  onChunk?: (text: string) => void,
  onReasoningChunk?: (reasoning: string) => void,
  timeoutMs?: number,
  onToolCallChunk?: (deltas: ToolCallDelta[]) => void,
): Promise<ChatResult> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, modelName, provider.configJson || {})

  const { path, body } = adapter.buildChatRequest(config, params)
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`
  const stream = params.stream ?? true

  const controller = new AbortController()
  const timeout = timeoutMs ?? CHAT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: resolveHeaders(adapter, config),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      let errBody = ''
      try {
        errBody = await response.text()
      } catch { /* */ }

      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(errBody)
      } catch {
        parsedBody = undefined
      }

      const message = adapter.mapChatError
        ? adapter.mapChatError(response.status, parsedBody)
        : `上游返回错误 (${response.status})`
      throw new Error(message)
    }

    if (stream) {
      if (!response.body) {
        throw new Error('上游未返回响应数据')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullContent = ''
      let fullReasoning = ''
      let finishReason = 'stop'
      let promptTokens = 0
      let completionTokens = 0
      let reasoningTokens = 0
      let totalTokens = 0
      // tool_calls 分片累积：按 index 归并，id/name 取首次出现值，arguments 逐片拼接
      const toolAcc = new Map<number, { id?: string; name?: string; args: string }>()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!adapter.parseChatStreamChunk) continue
          const parsed = adapter.parseChatStreamChunk(line)
          if (!parsed) continue

          if (parsed.content) {
            fullContent += parsed.content
            onChunk?.(parsed.content)
          }
          if (parsed.reasoning) {
            fullReasoning += parsed.reasoning
            onReasoningChunk?.(parsed.reasoning)
          }
          if (parsed.finishReason) {
            finishReason = parsed.finishReason
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.promptTokens || promptTokens
            completionTokens = parsed.usage.completionTokens || completionTokens
            reasoningTokens = parsed.usage.reasoningTokens || reasoningTokens
            totalTokens = parsed.usage.totalTokens || totalTokens
          }
          if (parsed.toolCalls) {
            for (const d of parsed.toolCalls) {
              const cur = toolAcc.get(d.index) || { args: '' }
              if (d.id) cur.id = d.id
              if (d.name) cur.name = d.name
              if (d.argumentsDelta) cur.args += d.argumentsDelta
              toolAcc.set(d.index, cur)
            }
            onToolCallChunk?.(parsed.toolCalls)
          }
        }
      }

      if (totalTokens === 0) {
        completionTokens = Math.ceil(fullContent.length / 3)
        reasoningTokens = Math.ceil(fullReasoning.length / 3)
        promptTokens = Math.ceil(
          params.messages.reduce((sum, m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            return sum + content.length
          }, 0) / 3,
        )
        totalTokens = promptTokens + completionTokens + reasoningTokens
      }

      const streamedToolCalls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, v]) => ({ id: v.id || `call_${idx}`, name: v.name || '', arguments: v.args }))
        .filter((c) => c.name)

      return {
        content: fullContent,
        reasoning: fullReasoning || undefined,
        finishReason,
        promptTokens,
        completionTokens,
        totalTokens,
        ...(streamedToolCalls.length ? { toolCalls: streamedToolCalls } : {}),
      }
    }

    const responseBody = await response.json()
    if (!adapter.parseChatResponse) {
      throw new Error('Adapter 未实现 parseChatResponse')
    }
    const parsed = adapter.parseChatResponse(responseBody)
    return {
      content: parsed.content,
      reasoning: parsed.reasoning,
      finishReason: parsed.finishReason,
      ...(parsed.toolCalls && parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      promptTokens: parsed.usage?.promptTokens || 0,
      completionTokens: parsed.usage?.completionTokens || 0,
      totalTokens: parsed.usage?.totalTokens || Math.ceil(parsed.content.length / 3),
    }
  } catch (err) {
    // 原来这里没有 catch：undici 的网络错误会裸抛出去，
    // 上游面板只留一句 "fetch failed"。统一翻译成中文 + 机器码。
    throw toUpstreamError(err)
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function invokeImage(
  provider: VideoProvider,
  modelName: string,
  params: ImageParams,
  userId: string
): Promise<ImageResult> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })

  if (!adapter.buildImageRequest || !adapter.parseImageResponse) {
    throw new Error('当前 Adapter 不支持图片生成')
  }

  // 只对 429（限流）自动重试：工具页一次点「开始生成」会串行跑多份子图，上游常按 RPS 限流。
  //
  // 为什么不重试 5xx：5xx 与 429 不同 —— 请求可能已被上游受理并出图，只是响应阶段失败。
  // 自动重试会让同一 prompt 在上游被生成两次（上游按次计费 = 重复出图/重复扣上游费），
  // 而本地只退一次扣一次，成本全落在平台。宁可让用户手动重试，也不做可能重复计费的自动重试。
  for (let attempt = 0; ; attempt++) {
    try {
      // 全平台闸门：先按速率拿派发令牌，再占在途名额。
      // 放在这里（而不是各 API 路由）是为了让工具箱 / 画布 / Copilot / Agent 全部受同一约束。
      return await withUpstreamGate(() => invokeImageOnce(provider, modelName, params, userId, adapter), userId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      const retryable = /^请求频率过高/.test(msg)
      if (!retryable || attempt >= 2) throw err
      await new Promise((r) => setTimeout(r, [2000, 5000, 10000][attempt]))
    }
  }
}

async function invokeImageOnce(
  provider: VideoProvider,
  modelName: string,
  params: ImageParams,
  userId: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>
): Promise<ImageResult> {
  if (!adapter.buildImageRequest || !adapter.parseImageResponse) {
    throw new Error('当前 Adapter 不支持图片生成')
  }
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, modelName, provider.configJson || {})
  const built = adapter.buildImageRequest(config, params)
  const { path, body } = built
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`

  const controller = new AbortController()
  // 超时标记：abort 触发的异常在 Node 里只报 "This operation was aborted"，
  // 对用户毫无意义。记下来在 catch 里翻译成「上游响应超时，请重试」。
  let timedOut = false
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, IMAGE_TIMEOUT_MS)

  try {
    // multipart 图生图（如 OpenAI /v1/images/edits）：body 为文本字段，imageFiles 先下载为文件后上传
    let requestBody: BodyInit
    let requestHeaders: Record<string, string>
    if (built.multipart) {
      const form = new FormData()
      if (body && typeof body === 'object') {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (v === undefined || v === null) continue
          form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
        }
      }
      const files = built.imageFiles || []
      for (let i = 0; i < files.length; i++) {
        const { buffer, mime, ext } = await fetchRemoteImage(files[i])
        form.append('image', new Blob([buffer as BlobPart], { type: mime }), `ref_${i}.${ext}`)
      }
      requestHeaders = resolveHeaders(adapter, config)
      delete requestHeaders['Content-Type'] // FormData 自带 boundary，不可手写
      requestBody = form
    } else {
      requestHeaders = resolveHeaders(adapter, config)
      requestBody = JSON.stringify(body)
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    })

    if (!response.ok) {
      let errBody = ''
      try {
        errBody = await response.text()
      } catch { /* */ }

      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(errBody)
      } catch {
        parsedBody = undefined
      }

      const message = adapter.mapImageError
        ? adapter.mapImageError(response.status, parsedBody)
        : `上游返回错误 (${response.status})`
      // 上游把「参考图拉不到」报成 invalid base64 之类的晦涩文案 → 翻成可读中文
      throw new Error(humanizeUpstreamMessage(message))
    }

    const responseBody = await response.json()
    const parsed = adapter.parseImageResponse(responseBody)

    if (parsed.imageUrl) {
      return { imageUrl: shouldRehost(provider.metadata) ? await rehostExternalAsset(parsed.imageUrl, userId, 'image') : parsed.imageUrl }
    }

    if (parsed.b64Json) {
      const buffer = Buffer.from(parsed.b64Json, 'base64')
      if (buffer.byteLength === 0) throw new Error('上游返回了空的图片数据')
      // 统一走 saveAssetWithRecord（落盘 + 登记 user_assets 一步到位）。
      // 原实现手写 mkdir+writeFile 只落盘不登记 → 产物只能靠 24h 孤儿清理回收（画布产物约 24h 后 404）。
      const prisma = await getPrisma()
      const saved = await saveAssetWithRecord(prisma, userId, buffer, { mime: 'image/png', type: 'image', source: 'generated' })
      return { imageUrl: saved.url }
    }

    if (parsed.taskId) {
      return pollImageTaskUntilDone(adapter, config, parsed.taskId, parsed.pollPath, userId, provider.metadata)
    }

    throw new Error('上游未返回图像数据')
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `图片生成超时（${Math.round(IMAGE_TIMEOUT_MS / 1000)}s 未返回）。` +
        '通常是上游排队较慢或同时提交的图片太多，请稍后重试或减少一次生成的数量。',
      )
    }
    // 网络层失败（undici）会把真实原因藏在 err.cause 里，
    // 不翻译的话运维面板只能看到一句 "fetch failed"，无法定位。
    throw toUpstreamError(err)
  } finally {
    clearTimeout(timeoutId)
  }
}

// 轮询异步图片任务直到终态（completed/failed）或超时
async function pollImageTaskUntilDone(
  adapter: RuntimeProviderAdapter,
  config: AdapterConfig,
  taskId: string,
  pollPath: string | undefined,
  userId: string,
  metadata?: Record<string, unknown> | null,
): Promise<{ imageUrl: string }> {
  if (!adapter.parseImageStatus) {
    throw new Error('异步图片接口未实现 parseImageStatus，无法轮询结果')
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const pathBase = (pollPath || '/images/generations').replace(/\/+$/, '')
  const endpoint = `${baseUrl}${pathBase}/${encodeURIComponent(taskId)}`
  const headers = resolveHeaders(adapter, config)

  const deadlineAt = Date.now() + IMAGE_TIMEOUT_MS
  // 初始等待：任务排队需要时间
  await sleep(5000)
  let attempt = 0

  while (Date.now() < deadlineAt) {
    try {
      const res = await fetch(endpoint, { method: 'GET', headers })
      const body = await res.json()
      if (res.ok) {
        const st = adapter.parseImageStatus(body)
        if (st.status === 'SUCCESS') {
          if (!st.imageUrl) {
            throw new Error('图片任务完成但未返回图片 URL')
          }
          return { imageUrl: shouldRehost(metadata) ? await rehostExternalAsset(st.imageUrl, userId, 'image') : st.imageUrl }
        }
        if (st.status === 'FAILED') {
          throw new Error(st.error || '图片任务失败')
        }
      }
      // PENDING / 非 ok：继续轮询
    } catch (err: unknown) {
      if (err instanceof Error && /图片任务|描述|错误/.test(err.message)) throw err
      // 网络抖动视为暂时失败，继续轮询
    }
    attempt++
    // 轮询间隔 5-10s 加抖动，规避上游限流
    const waitMs = Math.min(10000, 5000 + attempt * 500) + Math.floor(Math.random() * 2000)
    await sleep(waitMs)
  }
  throw new Error(`图片任务生成超时（${Math.round(IMAGE_TIMEOUT_MS / 1000)}s）`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 下载 multipart 图生图的参考图：支持公网 URL 与 data:image base64 两种输入，返回可上传的二进制 buffer
async function fetchRemoteImage(url: string): Promise<{ buffer: ArrayBuffer; mime: string; ext: string }> {
  if (url.startsWith('data:image/')) {
    const comma = url.indexOf(',')
    const meta = url.slice(5, comma) // 形如 image/png;base64
    const mime = meta.split(';')[0] || 'image/png'
    const b64 = url.slice(comma + 1)
    const buf = Buffer.from(b64, 'base64')
    const ext = mime.includes('png') ? 'png' : 'jpg'
    return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, mime, ext }
  }
  // Read a local upload without sending it through the remote URL fetcher.
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').origin
  const parsed = new URL(url, origin)
  const file = parsed.origin === origin && /^\/(?:api\/asset|generated)\/[\w-]+\/assets\/[\w.-]+$/.test(parsed.pathname)
    ? fileOfAssetUrl(parsed.pathname)
    : null
  if (file) {
    const data = await readFile(file)
    const mime = sniffImageMime(data)
    if (!mime) throw new Error('参考图片格式无效')
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
    return { buffer: Uint8Array.from(data).buffer, mime, ext }
  }
  // 参考图下载是图生图的前置，慢 CDN / 大图 30s 会误杀。
  // 30s → 90s，给足下载时间（真正卡住时上游生图超时 480s 兜底）。
  let res: Response
  try {
    // 必须走 safeFetch（Q-D18）：参考图 URL 由用户直接提供，裸 fetch 等于把 SSRF
    // 防护整个绕过（同文件 rehostExternalAsset / asset-proxy 都有逐跳校验）。
    res = await safeFetch(url, { signal: AbortSignal.timeout(90000) })
  } catch (err) {
    // 参考图是图生图的前置：下载失败要能说清是「网络」还是「上游拒绝」。
    // 网络失败时 undici 只给 "fetch failed"，这里翻译成中文 + 机器码。
    const e = toUpstreamError(err)
    throw new Error(`参考图下载失败：${e.message}`)
  }
  if (!res.ok) throw new Error(`参考图下载失败 (${res.status})`)
  const ab = await res.arrayBuffer()
  const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png'
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png'
  return { buffer: ab, mime, ext }
}

export async function pollImageStatus(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  taskId: string,
  pollPath?: string
): Promise<{ status: 'PENDING' | 'SUCCESS' | 'FAILED'; imageUrl?: string; error?: string }> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })
  if (!adapter.parseImageStatus) return { status: 'PENDING' }
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, '', provider.configJson || {})
  const path = (pollPath || '/images/generations').replace(/\/+$/, '') + `/${encodeURIComponent(taskId)}`
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: resolveHeaders(adapter, config),
    })
    if (!response.ok) return { status: 'PENDING' }
    const body = await response.json()
    return adapter.parseImageStatus(body)
  } catch {
    return { status: 'PENDING' }
  }
}

/** 视频生成：走全平台闸门（提交 + 轮询全程占在途名额） */
export async function invokeVideo(
  provider: VideoProvider,
  modelName: string,
  params: VideoParams,
  userId: string
): Promise<VideoResult> {
  return withUpstreamGate(() => invokeVideoOnce(provider, modelName, params, userId), userId)
}

async function invokeVideoOnce(
  provider: VideoProvider,
  modelName: string,
  params: VideoParams,
  userId: string
): Promise<VideoResult> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })

  if (!adapter.buildVideoRequest || !adapter.parseVideoResponse) {
    throw new Error('当前 Adapter 不支持视频生成')
  }

  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, modelName, provider.configJson || {})
  const { path, body, pollPath } = adapter.buildVideoRequest(config, params)
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: resolveHeaders(adapter, config),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      let errBody = ''
      try { errBody = await response.text() } catch { /* */ }
      let parsedBody: unknown
      try { parsedBody = JSON.parse(errBody) } catch { parsedBody = undefined }
      const message = adapter.mapVideoError
        ? adapter.mapVideoError(response.status, parsedBody)
        : `上游返回错误 (${response.status})`
      throw new Error(message)
    }

    const responseBody = await response.json()
    const parsed = adapter.parseVideoResponse(responseBody)

    if (parsed.videoUrl) {
      return { videoUrl: shouldRehost(provider.metadata) ? await rehostExternalAsset(parsed.videoUrl, userId, 'video') : parsed.videoUrl }
    }
    if (parsed.taskId) {
      return { taskId: parsed.taskId, pollPath: parsed.pollPath || pollPath }
    }

    throw new Error('上游未返回视频数据')
  } catch (err) {
    throw toUpstreamError(err)
  } finally {
    clearTimeout(timeoutId)
  }
}

// 轮询上游视频任务状态
export async function pollVideoStatus(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  taskId: string,
  pollPath?: string
): Promise<VideoStatus> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })
  if (!adapter.parseVideoStatus) {
    return { status: 'PENDING' }
  }
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, '', provider.configJson || {})
  // 厂商可自定义查询请求（query 参数式 / POST 查询等）；缺省 GET {pollPath}/{taskId}
  const custom = adapter.buildVideoStatusRequest
    ? adapter.buildVideoStatusRequest(config, taskId, pollPath)
    : null
  const path = custom
    ? custom.path
    : (pollPath || '/videos').replace(/\/+$/, '') + `/${encodeURIComponent(taskId)}`
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(endpoint, {
      method: custom?.method || 'GET',
      headers: resolveHeaders(adapter, config),
      ...(custom?.body !== undefined ? { body: JSON.stringify(custom.body) } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      const errMsg = `视频任务查询失败 (${response.status})`
      return { status: 'FAILED', error: errMsg }
    }
    const body = await response.json()
    return adapter.parseVideoStatus(body)
  } catch {
    return { status: 'PENDING' }
  } finally {
    clearTimeout(timeoutId)
  }
}

// 音频生成（音乐/配音/音效）。提交返回 audioUrl(同步) 或 taskId(异步待轮询)。
/** 音频生成：走全平台闸门 */
export async function invokeAudio(
  provider: VideoProvider,
  modelName: string,
  params: AudioParams,
  userId: string
): Promise<AudioResult> {
  return withUpstreamGate(() => invokeAudioOnce(provider, modelName, params, userId), userId)
}

async function invokeAudioOnce(
  provider: VideoProvider,
  modelName: string,
  params: AudioParams,
  userId: string
): Promise<AudioResult> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })

  if (!adapter.buildAudioRequest || !adapter.parseAudioResponse) {
    throw new Error('当前 Adapter 不支持音频生成')
  }

  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, modelName, provider.configJson || {})
  const { path, body, pollPath } = adapter.buildAudioRequest(config, params)
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: resolveHeaders(adapter, config),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      let errBody = ''
      try { errBody = await response.text() } catch { /* */ }
      let parsedBody: unknown
      try { parsedBody = JSON.parse(errBody) } catch { parsedBody = undefined }
      const message = adapter.mapAudioError
        ? adapter.mapAudioError(response.status, parsedBody)
        : `上游返回错误 (${response.status})`
      throw new Error(message)
    }

    const responseBody = await response.json()
    const parsed = adapter.parseAudioResponse(responseBody)

    if (parsed.audioUrl) {
      return { audioUrl: shouldRehost(provider.metadata) ? await rehostExternalAsset(parsed.audioUrl, userId, 'audio') : parsed.audioUrl }
    }

    // 内联音频（base64 或 hex）：落盘到素材目录后回填本地 URL（与图片 b64Json 同模式）
    const inlineAudio = parsed.b64Audio || parsed.audioHex
    if (inlineAudio) {
      const buffer = parsed.b64Audio
        ? Buffer.from(parsed.b64Audio, 'base64')
        : Buffer.from(parsed.audioHex!.replace(/\s+/g, ''), 'hex')
      const { mkdir, writeFile } = await import('fs/promises')
      const { resolve } = await import('path')
      const { randomUUID } = await import('crypto')
      const ext = parsed.audioMime?.includes('wav') ? 'wav' : parsed.audioMime?.includes('ogg') ? 'ogg' : 'mp3'
      const fileName = `${randomUUID()}.${ext}`
      const dir = resolve(ASSET_DIR, userId)
      await mkdir(dir, { recursive: true })
      await writeFile(resolve(dir, fileName), buffer)
      return { audioUrl: `${ASSET_URL_PREFIX}/${userId}/${fileName}` }
    }

    if (parsed.taskId) {
      return { taskId: parsed.taskId, pollPath: parsed.pollPath || pollPath }
    }

    throw new Error('上游未返回音频数据')
  } catch (err) {
    throw toUpstreamError(err)
  } finally {
    clearTimeout(timeoutId)
  }
}

// 轮询上游音频任务状态（GMI 音乐/配音为异步 request_id 轮询）
export async function pollAudioStatus(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  taskId: string,
  pollPath?: string
): Promise<AudioStatus> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })
  if (!adapter.parseAudioStatus) {
    return { status: 'PENDING' }
  }
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, '', provider.configJson || {})
  const path = (pollPath || '/requests').replace(/\/+$/, '') + `/${encodeURIComponent(taskId)}`
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: resolveHeaders(adapter, config),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { status: 'FAILED', error: `音频任务查询失败 (${response.status})` }
    }
    const body = await response.json()
    return adapter.parseAudioStatus(body)
  } catch {
    return { status: 'PENDING' }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function invokeTest(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  }
): Promise<{ status: 'ok' | 'auth_error' | 'error'; message: string }> {
  const adapter = await getAdapter({ adapterId: provider.adapterId })

  if (!adapter.buildTestRequest || !adapter.parseTestResponse) {
    return { status: 'ok', message: '当前 Adapter 未提供测试逻辑' }
  }

  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, '', provider.configJson || {})
  const request = adapter.buildTestRequest(config)
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${request.path}`

  try {
    const response = await fetch(endpoint, {
      method: request.method || 'GET',
      // request.headers 来自 buildTestRequest 的自定义头；鉴权头统一走 resolveHeaders（buildHeaders 或默认 Bearer）
      headers: { ...resolveHeaders(adapter, config), ...(request.headers || {}) },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    })

    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }

    const result = adapter.parseTestResponse(response, body)
    return { status: result.status, message: result.message || '测试完成' }
  } catch (err: unknown) {
    // 连通性测试是最需要看清原因的地方（用户/管理员据此判断 Key 还是网络问题），
    // 所以这里也走统一翻译，把 ECONNRESET / ENOTFOUND 这类码带出来。
    const message = toUpstreamError(err).message
    return { status: 'error', message }
  }
}

/**
 * 探测某模型支持的尺寸列表（GET /models）。
 *
 * 为什么收进这里：此前 canvas-executor 自己 fetch 上游 /models，是 src 内**唯一的裸 fetch**，
 * 绕过了 adapter 鉴权头（buildHeaders）与网络错误翻译，换一家用非 Bearer 鉴权的厂商就会 401。
 *
 * 只用于「模型 metadata.sizes 没配」时的兜底探测，失败一律返回 []（不影响主流程）。
 */
export async function fetchModelSizes(
  provider: {
    baseUrl: string
    apiKey: string | null
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  modelName: string,
): Promise<string[]> {
  if (!provider.apiKey) return []
  const adapter = await getAdapter({ adapterId: provider.adapterId })
  const config = buildAdapterConfig(provider.baseUrl, provider.apiKey, modelName, provider.configJson || {})
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/models`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: resolveHeaders(adapter, config),
      signal: controller.signal,
    })
    if (!res.ok) return []
    const body = (await res.json()) as Record<string, unknown>
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const found = (list as { id?: string; sizes?: unknown; supported_sizes?: unknown; size_presets?: unknown; resolutions?: unknown }[])
      .find((m) => m?.id === modelName)
    if (!found) return []
    // 常见格式：sizes / supported_sizes / size_presets / resolutions
    const rawSizes = found.sizes || found.supported_sizes || found.size_presets || found.resolutions
    if (Array.isArray(rawSizes)) return rawSizes.map(String)
    if (typeof rawSizes === 'string') return rawSizes.split(',').map((x) => x.trim()).filter(Boolean)
    return []
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

export { buildAdapterConfig, getAdapter }
export type { AdapterConfig, ChatParams, ImageParams, TokenUsage }
