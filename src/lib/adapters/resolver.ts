// resolver：把声明式 VendorProfile（Layer 1）编译成完整的 RuntimeProviderAdapter。
// 只填充"未手写实现的钩子"，命令式厂商可随意覆盖；未声明 profile 的 adapter 行为不变。
import type {
  RuntimeProviderAdapter,
  AdapterConfig,
  AdapterChatParams,
  AdapterImageParams,
  AdapterVideoParams,
  AdapterChatResponse,
  AdapterVideoStatus,
} from '@/types'
import { buildAuthHeaders } from './auth-scheme'
import { toVendorField } from './value-transform'
import { jsonGet, parseChatResponseFromSpec, parseOpenAIStyleStreamChunk, parseStatusFromShape } from './normalize/chat'

// ---------- chat 请求构建（Flat body：model/messages/参数并列顶层） ----------
function buildChatRequestFromProfile(
  config: AdapterConfig,
  params: AdapterChatParams,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['chat']>,
): { path: string; body: Record<string, unknown> } {
  const fc = profile.fieldMap
  const aliases = fc.aliases || {}
  const transforms = fc.transforms || {}
  const mode = fc.systemMode || 'inline'

  // system 消息：separate 抽到顶层，inline 留在 messages
  let messages = params.messages ?? []
  let system: unknown
  if (mode === 'separate') {
    const sys = messages.find((m) => m.role === 'system')
    if (sys) system = (sys as { content: unknown }).content
    messages = messages.filter((m) => m.role !== 'system')
  }

  const body: Record<string, unknown> = {}

  const put = (internal: string, value: unknown) => {
    if (value === undefined || value === null) return
    const { key, value: v } = toVendorField(internal, value, aliases, transforms, config)
    body[key] = v
  }

  put('model', config.modelName)
  put('temperature', params.temperature !== undefined ? params.temperature : fc.defaults?.temperature)
  put('maxTokens', params.maxTokens !== undefined ? params.maxTokens : fc.defaults?.maxTokens)
  // 思考强度：只在调用方显式传入时下发（未传 = 保持厂商默认，不给不长思考的模型引入请求体变化）
  if (params.reasoningEffort !== undefined) put('reasoningEffort', params.reasoningEffort)
  // 工具声明：仅当调用方显式传入非空 tools 时才下发（不给不使用工具的场景引入任何请求体变化）
  if (params.tools && params.tools.length > 0) {
    put('tools', params.tools)
    put('toolChoice', params.toolChoice ?? 'auto')
  }
  // stream 默认 true（与既有 openai 行为一致）
  const streamKey = aliases.stream || 'stream'
  body[streamKey] = params.stream ?? true

  if (mode === 'separate') {
    if (system !== undefined) body[aliases.system || 'system'] = system
    body.messages = messages
  } else {
    body.messages = params.messages ?? []
  }

  // 额外顶层参数（top_p / stop / frequency_penalty ...）
  for (const k of fc.topLevel || []) {
    const v = (params as Record<string, unknown>)[k]
    if (v === undefined || v === null) continue
    if (k === 'system' || k === 'messages' || k === 'temperature' || k === 'maxTokens' || k === 'tools' || k === 'toolChoice') continue
    const { key, value } = toVendorField(k, v, aliases, transforms, config)
    body[key] = value
  }

  const endpoint = profile.endpoint
  const path = typeof endpoint.path === 'function' ? endpoint.path(config) : endpoint.path
  return { path, body }
}

// ---------- image 请求构建 / 响应归一化（默认 OpenAI 形态） ----------
function buildImageRequestFromProfile(
  config: AdapterConfig,
  params: AdapterImageParams,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['image']>,
): { path: string; body: Record<string, unknown> } {
  let body: Record<string, unknown>
  if (profile.request) {
    body = profile.request(config, params)
  } else {
    body = { model: config.modelName, prompt: params.prompt, n: 1 }
    if (params.width && params.height) body.size = `${params.width}x${params.height}`
    if (Array.isArray(params.referenceImages) && params.referenceImages.length > 0) {
      body.images = params.referenceImages
    }
  }
  const path = typeof profile.endpoint.path === 'function' ? profile.endpoint.path(config) : profile.endpoint.path
  return { path, body }
}

function parseImageResponseFromProfile(
  body: unknown,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['image']>,
): { imageUrl?: string; b64Json?: string; taskId?: string; pollPath?: string } {
  const spec = profile.response
  if (!spec) return {}
  const url = jsonGet(body, spec.urlPath)
  if (url !== undefined) return { imageUrl: String(url) }
  const b64 = jsonGet(body, spec.b64Path)
  if (b64 !== undefined) return { b64Json: String(b64) }
  const taskId = jsonGet(body, spec.taskIdPath)
  if (taskId !== undefined) return { taskId: String(taskId), pollPath: spec.pollPath }
  // 兼容块式 data 数组
  const item = (jsonGet(body, ['data']) as Record<string, unknown>[] | undefined)?.[0]
  if (item) {
    if (item.url !== undefined) return { imageUrl: String(item.url) }
    if (item.b64_json !== undefined) return { b64Json: String(item.b64_json) }
    if (item.id !== undefined || item.task_id !== undefined) {
      return { taskId: String(item.id ?? item.task_id), pollPath: spec.pollPath }
    }
  }
  return {}
}

function parseImageStatusFromProfile(
  body: unknown,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['image']>,
): { status: 'PENDING' | 'SUCCESS' | 'FAILED'; imageUrl?: string; error?: string } {
  const shape = profile.response?.statusShape
  const r = parseStatusFromShape(body, shape)
  return { status: r.status, imageUrl: r.url, error: r.error }
}

// ---------- video 请求构建 / 响应归一化（默认 OpenAI 形态） ----------
function buildVideoRequestFromProfile(
  config: AdapterConfig,
  params: AdapterVideoParams,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['video']>,
): { path: string; body: Record<string, unknown>; pollPath?: string } {
  let body: Record<string, unknown>
  if (profile.request) {
    body = profile.request(config, params)
  } else {
    body = { model: config.modelName, prompt: params.prompt }
    if (params.width && params.height) body.size = `${params.width}x${params.height}`
    if (params.duration) body.duration = params.duration
    if (params.aspectRatio) body.aspect_ratio = params.aspectRatio
    if (params.firstFrame) body.first_frame_image = params.firstFrame
    if (params.lastFrame) body.last_frame_image = params.lastFrame
    if (params.audio) body.audio = params.audio
  }
  // Endpoint selection may depend on the selected reference mode.
  const path = typeof profile.endpoint.path === 'function' ? profile.endpoint.path(config, params) : profile.endpoint.path
  return { path, body, pollPath: profile.pollPath }
}

function parseVideoResponseFromProfile(
  body: unknown,
  profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['video']>,
): { videoUrl?: string; taskId?: string; pollPath?: string } {
  const spec = profile.response
  if (!spec) return {}
  const url = jsonGet(body, spec.urlPath)
  if (url !== undefined) return { videoUrl: String(url) }
  const taskId = jsonGet(body, spec.taskIdPath)
  if (taskId !== undefined) return { taskId: String(taskId), pollPath: profile.pollPath }
  // 兼容块式 / 常见字段
  const item = (jsonGet(body, ['data']) as Record<string, unknown>[] | undefined)?.[0]
  if (item) {
    if (item.url !== undefined || item.video_url !== undefined) return { videoUrl: String(item.url ?? item.video_url) }
    if (item.id !== undefined) return { taskId: String(item.id), pollPath: profile.pollPath }
  }
  if (body && typeof body === 'object' && 'video_url' in body) return { videoUrl: String((body as Record<string, unknown>).video_url) }
  if (body && typeof body === 'object' && 'url' in body) return { videoUrl: String((body as Record<string, unknown>).url) }
  return {}
}

function parseVideoStatusFromProfile(body: unknown, profile: NonNullable<NonNullable<RuntimeProviderAdapter['profile']>['video']>): AdapterVideoStatus {
  const shape = profile.response?.statusShape
  const r = parseStatusFromShape(body, shape)
  return { status: r.status, videoUrl: r.url, error: r.error }
}

// ---------- 入口：补齐缺失钩子 ----------
export function enhanceWithProfile(adapter: RuntimeProviderAdapter): RuntimeProviderAdapter {
  const p = adapter.profile
  if (!p) return adapter

  const merged: RuntimeProviderAdapter = { ...adapter }

  // 鉴权头：profile.auth + profile.headers
  if (!merged.buildHeaders) {
    merged.buildHeaders = (config) => ({
      ...buildAuthHeaders(p.auth, config),
      ...(p.headers || {}),
    })
  }

  // chat
  if (p.chat) {
    if (!merged.buildChatRequest) {
      merged.buildChatRequest = ((profile) => (config, params) => buildChatRequestFromProfile(config, params, profile))(p.chat)
    }
    const responseSpec = p.chat.response
    if (!merged.parseChatResponse) {
      merged.parseChatResponse = ((spec) => (body: unknown): AdapterChatResponse => parseChatResponseFromSpec(body, spec))(
        responseSpec,
      )
    }
    if (!merged.parseChatStreamChunk && (p.chat.stream ?? 'sse') === 'sse') {
      merged.parseChatStreamChunk = parseOpenAIStyleStreamChunk
    }
  }

  // image
  if (p.image) {
    if (!merged.buildImageRequest) {
      merged.buildImageRequest = ((prof) => (config, params) => buildImageRequestFromProfile(config, params, prof))(p.image)
    }
    if (!merged.parseImageResponse) {
      merged.parseImageResponse = ((prof) => (body) => parseImageResponseFromProfile(body, prof))(p.image)
    }
    if (!merged.parseImageStatus && p.image.response?.statusShape) {
      merged.parseImageStatus = ((prof) => (body) => parseImageStatusFromProfile(body, prof))(p.image)
    }
  }

  // video
  if (p.video) {
    if (!merged.buildVideoRequest) {
      merged.buildVideoRequest = ((prof) => (config, params) => buildVideoRequestFromProfile(config, params, prof))(p.video)
    }
    if (!merged.parseVideoResponse) {
      merged.parseVideoResponse = ((prof) => (body) => parseVideoResponseFromProfile(body, prof))(p.video)
    }
    if (!merged.parseVideoStatus && p.video.response?.statusShape) {
      merged.parseVideoStatus = ((prof) => (body) => parseVideoStatusFromProfile(body, prof))(p.video)
    }
  }

  // test
  if (p.test) {
    if (!merged.buildTestRequest) {
      const t = p.test
      merged.buildTestRequest = () => ({ method: t.method || 'GET', path: t.path })
    }
    if (!merged.parseTestResponse) {
      merged.parseTestResponse = (response) => {
        if (response.ok) return { ok: true, status: 'ok', message: '连接正常' }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, status: 'auth_error', message: '认证失败' }
        }
        return { ok: false, status: 'error', message: '连接失败' }
      }
    }
  }

  return merged
}
