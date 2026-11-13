// Built-in OpenAI-compatible adapter source.
// This string is seeded into the ProviderAdapter table and executed at runtime by adapter-runtime.ts.
// Adapters must return an object implementing the ProviderAdapter interface.
//
// 架构说明：chat / 鉴权 / 连通性测试走「声明式 profile」（Layer 1，由 resolver 自动补齐钩子）；
// image / video / 错误文案保持命令式（厂商差异较大，显式实现更可靠）。
// 未经验证请勿改动 chat 部分，行为与原手写实现等价（已通过逐字段断言）。

export const OPENAI_COMPATIBLE_ADAPTER_SOURCE = String.raw`const adapter = {
  name: 'OpenAI Compatible',
  version: '1.1.0',
  description: 'Standard OpenAI API compatible adapter',

  profile: {
    meta: { name: 'OpenAI Compatible', code: 'openai-compatible', version: '1.1.0' },
    auth: { type: 'bearer' },
    chat: {
      endpoint: { method: 'POST', path: '/chat/completions', stream: true },
      fieldMap: {
        aliases: { maxTokens: 'max_tokens', reasoningEffort: 'reasoning_effort' },
        transforms: {},
        systemMode: 'inline',
        topLevel: [],
        defaults: { temperature: 0.7 },
      },
      stream: 'sse',
      response: {
        contentPath: ['choices', 0, 'message', 'content'],
        reasoningPath: ['choices', 0, 'message', 'reasoning_content'],
        reasoningAltPath: ['choices', 0, 'message', 'reasoning'],
        finishReasonPath: ['choices', 0, 'finish_reason'],
        usage: { path: ['usage'], promptTokens: 'prompt_tokens', completionTokens: 'completion_tokens', totalTokens: 'total_tokens' },
      },
    },
    test: { method: 'GET', path: '/models' },
  },

  mapChatError(status, body) {
    const msg = body?.error?.message
    const suffix = msg ? ': ' + msg : ''
    // 上游常把「额度/余额不足」也回成 401/403；按状态码直接报「认证失败」会把排查方向带偏。
    // 先看错误正文里有没有额度类关键词，命中就按余额问题报。
    if ((status === 401 || status === 403) && /预扣费额度|剩余额度|insufficient|quota|balance|余额|额度|欠费|billing/i.test(String(msg || ''))) {
      return '上游额度不足，请为供应商充值或更换模型' + suffix
    }
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 402) return '余额不足或额度已用完' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '模型不存在或无权访问' + suffix
    if (status >= 500) return '上游服务异常' + suffix
    return '上游返回错误 (' + status + ')' + suffix
  },

  buildImageRequest(config, params) {
    const body = {
      model: config.modelName,
      prompt: params.prompt,
      n: 1,
    }
    if (params.width && params.height) {
      body.size = params.width + 'x' + params.height
    }
    if (Array.isArray(params.referenceImages) && params.referenceImages.length > 0) {
      // 参考图:data URL 数组。部分 openai 兼容上游用 images 字段承载 img2img/多参考
      body.images = params.referenceImages
    }
    return { path: '/images/generations', body }
  },

  parseImageResponse(body) {
    const item = body.data?.[0]
    if (!item) return {}
    return { imageUrl: item.url, b64Json: item.b64_json }
  },

  mapImageError(status, body) {
    const msg = body?.error?.message
    const suffix = msg ? ': ' + msg : ''
    // 上游常把「额度/余额不足」也回成 401/403；按状态码直接报「认证失败」会把排查方向带偏。
    // 先看错误正文里有没有额度类关键词，命中就按余额问题报。
    if ((status === 401 || status === 403) && /预扣费额度|剩余额度|insufficient|quota|balance|余额|额度|欠费|billing/i.test(String(msg || ''))) {
      return '上游额度不足，请为供应商充值或更换模型' + suffix
    }
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 402) return '余额不足或额度已用完' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '图像生成接口不存在或模型不可用' + suffix
    if (status >= 500) return '上游服务异常' + suffix
    return '上游返回错误 (' + status + ')' + suffix
  },

  buildVideoRequest(config, params) {
    const body = {
      model: config.modelName,
      prompt: params.prompt,
    }
    if (params.width && params.height) {
      body.size = params.width + 'x' + params.height
    }
    if (params.duration) body.duration = params.duration
    if (params.aspectRatio) body.aspect_ratio = params.aspectRatio
    if (params.firstFrame) body.first_frame_image = params.firstFrame
    if (params.lastFrame) body.last_frame_image = params.lastFrame
    if (params.audio) body.audio = params.audio
    if (params.referenceImages?.length) body.reference_images = params.referenceImages
    if (params.referenceAudios?.length) body.reference_audios = params.referenceAudios
    if (params.referenceVideos?.length) body.reference_videos = params.referenceVideos
    return { path: '/videos/generations', body, pollPath: '/videos' }
  },

  parseVideoResponse(body) {
    // 同步直出: { data: [{ url }] } 或 { video_url } 或 { url }
    const item = body.data?.[0]
    if (item?.url || item?.video_url) return { videoUrl: item.url || item.video_url }
    if (body.video_url || body.url) return { videoUrl: body.video_url || body.url }
    // 异步任务: { task_id } / { id } / { data: { id } }
    if (body.task_id) return { taskId: String(body.task_id), pollPath: '/videos' }
    if (body.id) return { taskId: String(body.id), pollPath: '/videos' }
    if (item?.id) return { taskId: String(item.id), pollPath: '/videos' }
    return {}
  },

  parseVideoStatus(body) {
    // 常见状态字段: status / task_status / state
    const status = (body?.status || body?.task_status || body?.state || 'PENDING').toString().toLowerCase()
    const item = body?.data?.[0]
    const videoUrl = item?.url || item?.video_url || body?.video_url || body?.url
    if (videoUrl || ['success', 'succeeded', 'completed', 'finished', 'done'].includes(status)) {
      return { status: 'SUCCESS', videoUrl }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      return { status: 'FAILED', error: body?.error?.message || body?.message || '视频生成失败' }
    }
    return { status: 'PENDING' }
  },

  mapVideoError(status, body) {
    const msg = body?.error?.message
    const suffix = msg ? ': ' + msg : ''
    // 上游常把「额度/余额不足」也回成 401/403；按状态码直接报「认证失败」会把排查方向带偏。
    // 先看错误正文里有没有额度类关键词，命中就按余额问题报。
    if ((status === 401 || status === 403) && /预扣费额度|剩余额度|insufficient|quota|balance|余额|额度|欠费|billing/i.test(String(msg || ''))) {
      return '上游额度不足，请为供应商充值或更换模型' + suffix
    }
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 402) return '余额不足或额度已用完' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '视频生成接口不存在或模型不可用' + suffix
    if (status >= 500) return '上游服务异常' + suffix
    return '上游返回错误 (' + status + ')' + suffix
  },

  buildTestRequest(config) {
    return { method: 'GET', path: '/models' }
  },

  parseTestResponse(response, body) {
    if (response.ok) return { ok: true, status: 'ok', message: '连接正常' }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 'auth_error', message: '认证失败' }
    }
    return { ok: false, status: 'error', message: '连接失败' }
  },
}
`
