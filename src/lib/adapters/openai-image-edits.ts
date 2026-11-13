// ===== OpenAI 标准图像 Adapter（generations + edits 双端点）=====
//
// 为什么单独写一个 adapter（不能用通用 openai-compatible）：
//
// 通用 openai-compatible 的图生图是把参考图塞进 /images/generations 的 JSON
// `images` 字段。这不是 OpenAI 标准协议 —— 标准协议里图生图/编辑走的是
// **POST /images/edits（multipart 表单，image 文件字段）**。严格按标准实现的
// 上游会静默忽略 JSON 里的 images 字段并返回 200，用户拿到的是"凭空生成的图"
//
// 本 adapter 按 OpenAI 标准协议实现：
//   - 文生图：POST /images/generations（JSON：model/prompt/size）
//   - 图生图：POST /images/edits（multipart：model/prompt/size + image 文件 ×N）
//
// "generations 文生图 + edits 图生图" 的标准 OpenAI 兼容服务。
//
// size 透传 "WIDTHxHEIGHT" 像素格式（OpenAI 标准）。上游若只认固定档位
// （如 1024x1024）会自行校验并报 400，错误文案由 mapImageError 翻译。
// 返回兼容 url / b64_json 两种形式（标准协议返回 b64_json，部分代理返回 url）。

export const OPENAI_IMAGE_EDITS_ADAPTER_SOURCE = String.raw`const adapter = {
  name: 'OpenAI Image (generations + edits)',
  version: '1.0.0',
  description: 'OpenAI 标准图像协议：文生图 /images/generations(JSON)，图生图/编辑 /images/edits(multipart image 文件)',

  profile: {
    meta: { name: 'OpenAI Image (generations + edits)', code: 'openai-image-edits', version: '1.0.0' },
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

  buildImageRequest(config, params) {
    const refs = Array.isArray(params.referenceImages) ? params.referenceImages.filter(Boolean) : []
    const body = { model: config.modelName, prompt: params.prompt, n: 1 }
    if (params.width && params.height) {
      body.size = params.width + 'x' + params.height
    }

    // 有参考图 → OpenAI 标准图生图走 multipart /images/edits
    // provider-invoker 会把每个 URL/dataURI 下载成文件后以 'image' 字段重复 append
    if (refs.length > 0) {
      return {
        path: '/images/edits',
        body,
        multipart: true,
        imageFiles: refs.slice(0, 4),
      }
    }

    // 无参考图 → JSON 文生图
    return { path: '/images/generations', body }
  },

  parseImageResponse(body) {
    const item = body && body.data && body.data[0]
    if (!item) return {}
    return { imageUrl: item.url, b64Json: item.b64_json }
  },

  mapImageError(status, body) {
    const msg = (body && body.error && body.error.message) || (body && body.message)
    const suffix = msg ? ': ' + msg : ''
    if ((status === 401 || status === 403) && /预扣费额度|剩余额度|insufficient|quota|balance|余额|额度|欠费|billing/i.test(String(msg || ''))) {
      return '上游额度不足，请为供应商充值或更换模型' + suffix
    }
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 402) return '余额不足或额度已用完' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '图像生成接口不存在或模型不可用（确认上游支持 /images/generations 与 /images/edits）' + suffix
    if (status === 400 && /size/i.test(String(msg || ''))) {
      return '图片尺寸不被上游接受（标准格式为 WIDTHxHEIGHT 像素，如 1024x1024）' + suffix
    }
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
