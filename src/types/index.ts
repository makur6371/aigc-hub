import type {
  UserRole,
  UserStatus,
  SecurityLevel,
  BillingType,
  PointsLogType,
  CardKeyType,
  CardKeyStatus,
  ModelType,
  PricingType,
} from '@prisma/client'

// 枚举统一从 Prisma 生成类型 re-export（单一来源 = schema.prisma，避免手抄副本漂移）
export type { UserRole, UserStatus, SecurityLevel, BillingType, PointsLogType, CardKeyType, CardKeyStatus, ModelType, PricingType } from '@prisma/client'

export type ApiResponse<T = unknown> = {
  success: boolean
  data: T | null
  message: string
}

export type PaginationParams = {
  page?: number
  pageSize?: number
}

export type PaginatedData<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type User = {
  id: string
  phone: string | null
  email?: string | null
  nickname: string | null
  role: UserRole
  status: UserStatus
  points: number
  /**
   * 视频豆余额（与积分完全隔离的两套额度）。
   * 之前 `User` 类型里只有 points，导致任何想读豆余额的界面拿不到类型
   * （/api/user/profile 实际是返回 beans 的）—— 类型缺字段 = 下次有人加展示时
   * 又得手工补一遍，容易漏。凡是读用户资产的界面都该能拿到它。
   */
  beans?: number
  billingType: BillingType
  /**
   * 团队模式下的「可用额度」（出资人池子里的余额）；非团队成员为自身余额。
   * 前端展示余额一律以这两个字段为准，不能直接用 points/beans —— 团队成员
   * 自己的 points/beans 通常是 0，真实可花的是老板账上的。
   */
  availPoints?: number
  availBeans?: number
  isTeamBilling?: boolean
  selfPoints?: number
  selfBeans?: number
  /** 订阅到期时间（ISO；null=无订阅或已过期） */
  subscriptionExpiryAt?: string | null
  securityLevel?: SecurityLevel
  emailVerified?: boolean
  socialUid?: string | null
  socialProvider?: string | null
  createdAt: string
}

export type PointsLog = {
  id: string
  userId: string
  amount: number
  type: PointsLogType
  description: string | null
  createdAt: string
}

export type CardKey = {
  id: string
  code: string
  type: CardKeyType
  pointsValue: number | null
  durationDays: number | null
  status: CardKeyStatus
  usedByUserId: string | null
  usedAt: string | null
  createdAt: string
  expiresAt: string | null
}

export type ApiProvider = {
  id: string
  name: string
  code: string
  baseUrl: string
  apiKey: string | null
  configSchema: Record<string, unknown> | null
  adapterId: string | null
  configJson: Record<string, unknown> | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ProviderAdapter = {
  id: string
  name: string
  code: string
  description: string | null
  type: 'TYPESCRIPT' | 'JSON'
  source: string
  isBuiltin: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type TextModelMetadata = {
  think?: boolean
  contextWindow?: number
}

export type ImageModelMetadata = {
  modes?: ('text' | 'singleImage' | 'multiReference')[]
  sizes?: string[]
}

/** 视频生成方式（与 metadata.video.constraints.modes 对应）；multiReference 在 UI 上叫「全能参考」 */
export type VideoMode = 'text' | 'firstLastFrame' | 'multiReference'

export type VideoModelMetadata = {
  modes?: VideoMode[]
  audio?: 'optional' | false | true
  /** true = 固定专属工具使用，不进通用视频模型选择器 */
  exclusiveTool?: boolean
  durationResolutionMap?: { duration: number[]; resolution: string[] }[]
}

export type ModelMetadata = TextModelMetadata | ImageModelMetadata | VideoModelMetadata | Record<string, unknown>

export type ModelConfig = {
  id: string
  name: string
  modelName: string
  type: ModelType
  pricingType: PricingType
  costPoints: number
  isActive: boolean
  providerId: string
  supportsVision: boolean
  contextWindow: number | null
  metadata: ModelMetadata | null
  createdAt: string
  updatedAt: string
}

export type Agent = {
  id: string
  name: string
  avatar: string | null
  description: string | null
  systemPrompt: string
  defaultModelId: string | null
  isOfficial: boolean
  creatorId: string | null
  createdAt: string
  updatedAt: string
}

export type CanvasNodeSpec = {
  id: string
  nodeType: string
  label: string
  codeSchema: string
  isOfficial: boolean
  creatorId: string | null
  createdAt: string
  updatedAt: string
}

export type ApiUsageLog = {
  id: string
  userId: string
  modelId: string
  tokensUsed: number | null
  pointsDeducted: number
  statusCode: number | null
  errorMessage: string | null
  createdAt: string
}

export type ImageGenerationRecord = {
  id: string
  userId: string
  modelId: string
  prompt: string
  negativePrompt: string | null
  width: number | null
  height: number | null
  imageUrl: string
  costPoints: number
  status: string
  errorMessage: string | null
  expiresAt: string
  createdAt: string
}

export type VideoGenerationRecord = {
  id: string
  userId: string
  modelId: string
  prompt: string
  videoUrl: string | null
  costPoints: number
  status: string
  errorMessage: string | null
  expiresAt: string
  createdAt: string
}

export type ModelOption = {
  value: string
  label: string
  type: ModelType
  pricingType: PricingType
  costPoints: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export type ApiProviderConfigField = {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  required: boolean
  options?: string[]
  defaultValue?: unknown
}

export type ApiProviderInput = {
  name: string
  code: string
  baseUrl: string
  apiKey?: string
  configSchema: ApiProviderConfigField[]
  isActive?: boolean
}

export type CanvasNodeDefinition = {
  type: string
  label: string
  category: string
  inputs: Record<string, { type: string; required: boolean; label: string }>
  outputs: Record<string, { type: string; label: string }>
  run: (data: Record<string, unknown>) => Promise<Record<string, unknown>>
}

// Provider adapter hook types
export type AdapterConfig = {
  baseUrl: string
  apiKey: string | null
  modelName: string
  [key: string]: unknown
}

/**
 * 工具（function calling）声明：交给模型的「可调用动作」清单。
 *
 * 为什么需要：单次规划要求模型一次吐出完整大 JSON（intent/deliverables/...），
 * 一旦截断或格式不规范就整条失败。改成「小步动作」后每轮只输出一个 tool_call，
 * 天然规避大 JSON 截断，也让「缺参就问」「查模型能力」变成真实动作而非文本约定。
 */
export type AdapterToolSpec = {
  type: 'function'
  function: {
    name: string
    description?: string
    /** JSON Schema 参数定义 */
    parameters?: Record<string, unknown>
  }
}

/** 流式 tool_call 增量（OpenAI 形态：按 index 分片累积，arguments 是字符串片段） */
export type AdapterToolCallDelta = {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

/** 汇总后的完整 tool_call */
export type AdapterToolCall = {
  id: string
  name: string
  /** 模型给出的原始 JSON 字符串（由调用方负责容错解析） */
  arguments: string
}

export type AdapterChatParams = {
  systemPrompt?: string
  messages: { role: string; content: string | unknown; tool_calls?: unknown; tool_call_id?: string; name?: string }[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  /** 工具清单：非空时随请求体下发（OpenAI 兼容字段 tools） */
  tools?: AdapterToolSpec[]
  /** 工具选择策略（'auto' / 'none' / {type:'function',function:{name}}） */
  toolChoice?: unknown
  /**
   * 思考强度（OpenAI 兼容的 reasoning_effort：'none' | 'low' | 'medium' | 'high'）。
   *
   * 为什么必须有：思考模型（metadata.think=true）的 reasoning 与正文**共用输出预算**。
   * 实测生产：同一个 glm-5.3-flash，简单场景推理 1272 token、复杂场景会飙到 4700+，
   * 波动 3 倍不可预测 —— 一旦推理吃满 max_tokens，tool_call 就一个字都产不出来，
   * 表现为「思考很久然后失败/截断」。
   *
   * 实测（真实 6 方向套图工具调用场景）：effort=low 时推理 token 1272 → 19，
   * 耗时 40.3s → 16.7s，6 个 tool_call 一个不少。所以对「按约束产出动作」这类任务，
   * 压低思考强度是纯收益。
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
}

export type AdapterImageParams = {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  referenceImages?: string[]
}

export type AdapterVideoParams = {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  duration?: number
  aspectRatio?: string
  /**
   * 分辨率档（canonical，如 480P/720P/768P/1080P/2K）。
   *
   * `resolution` 字段是**独立枚举**（480p/768P/2K），不是从像素推出来的。
   * 之前只传 width/height，这些 adapter 拿不到档位 → 静默用上游默认清晰度，
   */
  resolution?: string
  firstFrame?: string // data URL
  lastFrame?: string // data URL
  audio?: string // data URL 或 URL
  /**
   * 音频截取时长（秒，1-15）。
   *
   * 为什么与 duration 分开：两者语义不同。
   *   `duration` = 期望的输出视频时长；
   *   `audio_duration`，默认 5 秒）。
   * 混用会导致「要 12 秒视频、却只截了 5 秒音频」——口型只对上前 5 秒。
   */
  audioDuration?: number
  referenceImages?: string[]
  /** 厂商特有扩展参数（如多路参考音频 refAudios、随机 seed）。adapter 自取自用。 */
  extras?: Record<string, unknown>
}

export type AdapterVideoStatus = {
  status: 'PENDING' | 'SUCCESS' | 'FAILED'
  videoUrl?: string
  error?: string
  /**
   * 有它就回填到调用日志的 taskProgress —— 后台「任务型调用」能看到任务卡在哪一步，
   * 而不是只显示一句「进行中」（这类模型排队十几分钟是常态）。
   */
  progress?: string
}

// 音频生成参数（音乐/配音/音效等）。字段宽松以覆盖不同厂商：
// prompt=主文本（配音要合成的文本 / 音乐的风格描述），lyrics=音乐歌词，voiceId=配音音色
export type AdapterAudioParams = {
  prompt: string
  lyrics?: string
  voiceId?: string
  format?: string // mp3/wav/pcm 等
  duration?: number
  extras?: Record<string, unknown>
}

export type AdapterAudioStatus = {
  status: 'PENDING' | 'SUCCESS' | 'FAILED'
  audioUrl?: string
  error?: string
  /** 同 AdapterVideoStatus.progress */
  progress?: string
}

export type AdapterTokenUsage = {
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export type AdapterChatStreamChunk = {
  content?: string
  reasoning?: string
  finishReason?: string
  usage?: AdapterTokenUsage
  /** 本轮增量携带的 tool_call 分片 */
  toolCalls?: AdapterToolCallDelta[]
}

export type AdapterChatResponse = {
  content: string
  finishReason: string
  reasoning?: string
  usage?: AdapterTokenUsage
  /** 非流式响应里的完整 tool_calls */
  toolCalls?: AdapterToolCall[]
}

export interface RuntimeProviderAdapter {
  name: string
  code?: string
  version?: string
  description?: string
  defaults?: {
    baseUrl?: string
    apiKey?: string
    modelName?: string
    configJson?: Record<string, unknown>
  }
  buildChatRequest(config: AdapterConfig, params: AdapterChatParams): { path: string; body: unknown }
  /**
   * 参考图传输方式（host 侧执行，adapter 沙箱无 IO 不能自己下载）。
   *
   * 为什么需要：图片以 `image_url.url` 交给上游时，**由上游来下载**。部分上游
   * ≥1.9MB 直接 27~38s 后放弃并报 `image down failed`），而同一张图改成
   * base64 内联则 200 成功。
   *
   * 'url'          —— 默认，原样传公网 URL（上游自己拉）
   * 'base64'       —— host 先把站内图/公网图下载并转成 data URL 再传
   * 'auto'         —— 站内图转 base64，公网外链仍传 URL（外链体积/时效不可控，转了反而更大）
   *
   * 由 adapter 声明、host 执行 —— 这样厂商差异留在 adapter 里，
   * 而下载/编码这类需要 IO 的动作留在 host，符合「沙箱不碰网络」的既有边界。
   */
  chatImageMode?: 'url' | 'base64' | 'auto'
  /** base64 内联的体积上限（字节）。超过则退回 URL。缺省 8MB（base64 后 ~10.7MB）。 */
  chatImageInlineMaxBytes?: number
  /** 构建请求头（鉴权差异：Bearer / x-api-key / X-Goog-Api-Key 等）。缺省时原样保留调用方兜底 */
  buildHeaders?(config: AdapterConfig): Record<string, string>
  /**
   * 声明式字段映射：把内部统一参数名/值映射为厂商特有格式。
   * 供通用 buildChatRequest 实现使用（厂商可覆盖 buildChatRequest 完全自定义）。
   */
  fieldMap?: {
    /** 字段名差异：内部名 → 厂商请求体字段名。如 { maxTokens: 'max_new_tokens' } */
    aliases?: Record<string, string>
    /** 值区间换算：{ temperature: { scale: 100 } } 表示内部 0~1 乘以 100 发厂商 0~100 */
    scales?: Record<string, { scale: number; offset?: number }>
    /** system 消息处理：'separate' 提到顶层 system 字段（Claude）、'inline' 留在 messages（Gemini/默认） */
    systemMessageMode?: 'separate' | 'inline'
  }
  parseChatStreamChunk?(chunk: string): AdapterChatStreamChunk | null
  parseChatResponse?(body: unknown): AdapterChatResponse
  mapChatError?(status: number, body: unknown): string
  /** 图片请求构造结果。默认 JSON body；multipart=true 时走 form-data（如 OpenAI /v1/images/edits 图生图） */
  buildImageRequest?(config: AdapterConfig, params: AdapterImageParams): {
    path: string
    body: unknown
    /** true=以 multipart/form-data 发送；默认 false=application/json */
    multipart?: boolean
    /** multipart 模式下，作为 'image' 字段上传的图片 URL/DataURI 列表（会先下载为文件） */
    imageFiles?: string[]
  }
  parseImageResponse?(body: unknown): { imageUrl?: string; b64Json?: string; taskId?: string; pollPath?: string }
  /** 异步任务式图片接口（如 ToAPIs）：提交返回 taskId，轮询本方法获取状态/结果 */
  parseImageStatus?(body: unknown): { status: 'PENDING' | 'SUCCESS' | 'FAILED'; imageUrl?: string; error?: string }
  mapImageError?(status: number, body: unknown): string
  buildVideoRequest?(config: AdapterConfig, params: AdapterVideoParams): { path: string; body: unknown; pollPath?: string }
  parseVideoResponse?(body: unknown): { videoUrl?: string; taskId?: string; pollPath?: string }
  parseVideoStatus?(body: unknown): AdapterVideoStatus
  mapVideoError?(status: number, body: unknown): string
  /**
   * 自定义「查询视频任务」请求（默认是 GET {pollPath}/{taskId}）。
   * 用于查询风格特殊的厂商：如 query 参数式（GET /result?id=xxx）、POST 查询、
   * 需要带 model 等。返回的 path 会拼在 baseUrl 后；可不含前导斜杠。
   */
  buildVideoStatusRequest?(config: AdapterConfig, taskId: string, pollPath?: string): { method?: string; path: string; body?: unknown }
  buildAudioRequest?(config: AdapterConfig, params: AdapterAudioParams): { path: string; body: unknown; pollPath?: string }
  parseAudioResponse?(body: unknown): { audioUrl?: string; b64Audio?: string; audioHex?: string; audioMime?: string; taskId?: string; pollPath?: string }
  parseAudioStatus?(body: unknown): AdapterAudioStatus
  mapAudioError?(status: number, body: unknown): string
  buildTestRequest?(config: AdapterConfig): { method?: string; path: string; headers?: Record<string, string>; body?: unknown }
  parseTestResponse?(response: { ok: boolean; status: number }, body: unknown): { ok: boolean; status: 'ok' | 'auth_error' | 'error'; message?: string }

  /**
   * 声明式厂商画像（Layer 1）。声明了 profile 的 adapter，缺失的钩子由 resolver
   * 依据画像自动补齐（鉴权头 / chat / image / video 请求与响应归一化）。
   * 未声明的 adapter 行为完全不变（向后兼容）。命令式厂商（ToAPIs 等）仍可直接手写钩子。
   */
  profile?: VendorProfile
}

// ============================================================
// 声明式多厂商画像（Layer 1）
// 用纯数据描述一家上游厂商，由 resolver 生成默认钩子，显著降低新增厂商成本。
// ============================================================

/** 鉴权策略：替代手写 buildHeaders 的声明式写法 */
export type AuthScheme =
  | { type: 'bearer' }                                    // Authorization: Bearer <key>
  | { type: 'api-key-header'; header: string }            // x-api-key / x-goog-api-key ...
  | { type: 'api-key-query'; param: string }              // 部分网关支持 ../?key=<key>
  | { type: 'custom'; headers?: Record<string, string> }  // 静态+组合头（Anthropic 等）

/** 值转换：把内部统一参数值映射成厂商格式 */
export type ValueTransform =
  | { type: 'scale'; scale: number; offset?: number }         // 0~1 → 0~100
  | { type: 'clamp'; min?: number; max?: number }
  | { type: 'enum'; map: Record<string, string> }            // 内部枚举 → 厂商枚举
  | { type: 'format'; template: string }                     // '{w}x{h}' → '1024x1024'
  | { type: 'bool'; as: 'boolean' | '0/1' | 'true/false' }
  | { type: 'tostring' }

/** JSON 路径：['data', 0, 'b64_json'] → body.data[0].b64_json */
export type JsonPath = (string | number)[]

/** chat 响应归一化规格：如何从上游响应体抽出 { content, reasoning, finishReason, usage } */
export interface ChatResponseSpec {
  /** 文本路径抽取（openai: ['choices',0,'message','content']） */
  contentPath?: JsonPath
  /** 块式抽取（Claude: content[] 中 type==='text' 的 text 拼接） */
  contentBlocks?: { field: string; typeKey?: string; textType?: string; textKey?: string }
  /** 思考/reasoning 路径 */
  reasoningPath?: JsonPath
  /** reasoning 备用路径（如 openai 部分厂商用 reasoning 而非 reasoning_content） */
  reasoningAltPath?: JsonPath
  /** 终止原因路径 */
  finishReasonPath?: JsonPath
  /** 厂商终止码 → 内部语义（'stop'/'length'） */
  finishMap?: Record<string, string>
  /** usage 抽取：提示/补全/思考/总 token 在 usage 内各自的字段名 */
  usage?: {
    path?: JsonPath
    promptTokens?: string
    completionTokens?: string
    reasoningTokens?: string
    totalTokens?: string
  }
}

/** chat 字段映射：统一内部参数 → 厂商请求体字段 */
export interface ChatFieldConfig {
  /** 统一内部名 → 厂商请求体字段名（如 { maxTokens: 'max_output_tokens' }） */
  aliases?: Record<string, string>
  /** 每个内部参数的值转换 */
  transforms?: Record<string, ValueTransform>
  /** system 消息处理：'separate' 提到顶层（Claude）、'inline' 留在 messages（Gemini/默认） */
  systemMode?: 'inline' | 'separate'
  /** 额外落到请求体顶层的内部参数名（top_p/stop/frequency_penalty ...） */
  topLevel?: string[]
  /** 内部参数缺省值（如 openai temperature 缺省 0.7），无值时回退 */
  defaults?: Record<string, unknown>
}

/** chat 端点描述 */
export interface ChatEndpoint {
  method?: string
  /** 相对 baseUrl 的路径，可用函数做动态拼接（如 '/models/'+model+':generateContent'） */
  path: string | ((config: AdapterConfig) => string)
  stream?: boolean
}

/** image 请求构建 + 响应归一化规格 */
export interface VendorImageProfile {
  endpoint: { method?: string; path: string | ((config: AdapterConfig) => string) }
  /** 请求体字段映射（可缺省，用默认 OpenAI 形态） */
  request?: (config: AdapterConfig, params: AdapterImageParams) => Record<string, unknown>
  /** 响应归一化：url / base64 / 异步任务 */
  response?: {
    urlPath?: JsonPath
    b64Path?: JsonPath
    taskIdPath?: JsonPath
    pollPath?: string
    statusShape?: StatusShape
  }
}

/** video 请求构建 + 响应归一化规格 */
export interface VendorVideoProfile {
  /**
   * path 回调第二参 params（可选）：按本次素材形态选上游工作流的厂商
   * 旧签名 path(config) 依旧兼容（TS 函数参数逆变，1 参函数可赋给 2 参签名）。
   */
  endpoint: { method?: string; path: string | ((config: AdapterConfig, params?: AdapterVideoParams) => string) }
  pollPath?: string
  request?: (config: AdapterConfig, params: AdapterVideoParams) => Record<string, unknown>
  response?: {
    urlPath?: JsonPath
    taskIdPath?: JsonPath
    statusShape?: StatusShape
  }
}

/** 异步任务（image/video）轮询状态归一化 */
export interface StatusShape {
  statusPath?: JsonPath
  urlPath?: JsonPath
  errorPath?: JsonPath
  completed?: (string | RegExp)[]
  failed?: (string | RegExp)[]
  statusDefault?: 'PENDING' | 'SUCCESS' | 'FAILED'
}

/** 厂商画像总类型 */
export interface VendorProfile {
  meta: { name: string; code: string; version: string; docs?: string }
  auth?: AuthScheme
  /** 静态额外请求头（如 anthropic-version） */
  headers?: Record<string, string>
  chat?: { endpoint: ChatEndpoint; fieldMap: ChatFieldConfig; stream?: 'sse' | 'raw-text'; response: ChatResponseSpec }
  image?: VendorImageProfile
  video?: VendorVideoProfile
  test?: { method?: string; path: string }
}
