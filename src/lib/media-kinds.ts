// ===== 媒体模态注册表（唯一按「图片/视频/音频」分叉的地方）=====
//
// 为什么要有这个文件：
//   业务上只有两种通信模式 —— LLM 走 SSE 长连接；图/视频/音频都是「任务型」
//   （提交 → 句柄 → 同步直出或轮询）。既然图/视频/音频在通信上是同一回事，
//   就不该在每一层（记录表读取、调用日志渲染、素材列表、成果区、MCP）
//   各写一份 `image ? ... : video ? ... : audio ? ...`。
//
//   现状是分叉散落在 8+ 处（见 docs/DEV_HANDOFF），每加一种模态就要全平台补一遍，
//   漏一处就出 bug（例：调用日志 extractImageUrl 只认图片，视频也被显示成「无图片」）。
//
// 收口方式：
//   这里集中声明「某模态是什么」——中文名、MIME 前缀、对应模型类型、
//   在各记录表里的 URL 字段名、以及从 MIME / URL 反推模态的逻辑。
//   其他所有层只 import 这里的映射，不再自己写三元链。

/** 媒体模态。四种「产出」里文本没有独立记录表，故此处只覆盖媒体三态。 */
export type MediaKind = 'image' | 'video' | 'audio'

// 注意：本文件被**客户端组件**引用（如调用日志、素材列表），
// 因此绝不能 import asset-store 之类带 fs/path 的服务端模块。
// MIME 判定在这里自实现，与 asset-store 的口径保持一致（image//video//audio/）。
const MEDIA_MIME_PREFIXES: Record<MediaKind, string> = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
}

const MEDIA_EXT: Record<MediaKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'],
  video: ['.mp4', '.webm', '.mov', '.m4v'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'],
}

export interface MediaKindMeta {
  /** 中文名，用于 UI 文案 / 消息提示 */
  label: string
  /** MIME 前缀，用于从 Content-Type 判定 */
  mimePrefix: string
  /** 对应 ModelConfig.type（TEXT/VISION/IMAGE/VIDEO/AUDIO） */
  modelType: 'IMAGE' | 'VIDEO' | 'AUDIO'
  /** 该模态在生成记录表里的 URL 字段名 */
  recordUrlField: 'imageUrl' | 'videoUrl' | 'audioUrl'
  /** 上传/拖拽区 accept 值，如 'image/*' */
  accept: string
}

export const MEDIA_KINDS: Record<MediaKind, MediaKindMeta> = {
  image: { label: '图片', mimePrefix: 'image/', modelType: 'IMAGE', recordUrlField: 'imageUrl', accept: 'image/*' },
  video: { label: '视频', mimePrefix: 'video/', modelType: 'VIDEO', recordUrlField: 'videoUrl', accept: 'video/*' },
  audio: { label: '音频', mimePrefix: 'audio/', modelType: 'AUDIO', recordUrlField: 'audioUrl', accept: 'audio/*' },
}

/** 全部模态（稳定顺序：图 → 视频 → 音频） */
export const MEDIA_KIND_LIST: MediaKind[] = ['image', 'video', 'audio']

/** 模态 → 中文名；未知回退为「产物」，避免 UI 出现 undefined */
export function mediaLabel(kind: string | null | undefined): string {
  return (kind && MEDIA_KINDS[kind as MediaKind]?.label) || '产物'
}

/** 模态 → ModelConfig.type */
export function mediaModelType(kind: MediaKind): string {
  return MEDIA_KINDS[kind].modelType
}

/**
 * Agent 交付物类型 → ModelConfig.type。
 * Agent 的 DeliverableType 比媒体多一个 'text'（LLM 产物），
 * 这里一并映射，让 Agent 侧不再自己写 text/image/video/audio 四元链。
 */
export function modelTypeFromDeliverable(kind: string): 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' {
  if (kind === 'text') return 'TEXT'
  return MEDIA_KINDS[kind as MediaKind]?.modelType ?? 'IMAGE'
}

/**
 * 作品/内容卡片的占位字形（无封面时用）。
 * 覆盖三种：视频 ▶、图片 🖼、其余（工作流/文本）✦ —— 收敛掉各处的三元链。
 */
export function workTypeGlyph(type: string | null | undefined): string {
  if (type === 'video') return '▶'
  if (type === 'image') return '🖼'
  if (type === 'audio') return '♪'
  return '✦'
}

/**
 * 画布/工具节点分类 → 需要展示的模型类型。
 * 图像节点只要 IMAGE、视频节点只要 VIDEO、音频节点只要 AUDIO，
 * 其余（文本/对话）取 TEXT + VISION。收敛掉 page-fields / ToolPanel 里的三元链。
 */
export function modelTypesForCategory(category: string | null | undefined): string[] {
  if (category === 'image' || category === 'video' || category === 'audio') {
    return [MEDIA_KINDS[category].modelType]
  }
  return ['TEXT', 'VISION']
}

/** ModelConfig.type → 模态（非媒体模型返回 null），如 'IMAGE' → 'image' */
export function kindFromModelType(modelType: string | null | undefined): MediaKind | null {
  if (!modelType) return null
  const found = MEDIA_KIND_LIST.find((k) => MEDIA_KINDS[k].modelType === modelType.toUpperCase())
  return found ?? null
}

/**
 * ModelConfig.type → 产物模态（含文本）。
 * 写入调用日志 outputKind 时用：TEXT/VISION → 'text'，IMAGE/VIDEO/AUDIO → 对应模态。
 * 这是「一次调用的产物是什么」在**写入时刻**就定死的依据，替代前端事后 regex 猜测。
 */
export function outputKindFromModelType(modelType: string | null | undefined): 'text' | MediaKind | null {
  if (!modelType) return null
  const t = modelType.toUpperCase()
  if (t === 'TEXT' || t === 'VISION') return 'text'
  return kindFromModelType(t)
}

/**
 * 调用形态：任务型 vs 会话型。
 *
 *   'task'   —— 生成图片/视频/音频这类**任务型**调用：上游多半是「提交拿 taskId → 轮询取结果」，
 *              或者至少是慢速一次性生成。它们关心的是 任务ID / 状态 / 进度 / 耗时，
 *              计费单位是「积分或豆/次（或按秒）」。
 *   'llm'    —— 大语言模型这类**会话型**调用：SSE 流式、关心 token 用量与首字延迟，
 *              计费单位是「积分/Token」。
 *
 * 为什么要有这个分类：后台「调用记录」把它们混在一张表里，会出现
 *   「图片调用的 Tokens 列永远空、LLM 调用的产物列永远是文本」这种两边都不贴合的表。
 * 拆成两张表、各自列自己关心的字段，才读得懂（对齐 New API 的「使用日志 / 任务日志」分栏）。
 *
 * 判定依据：模型类型（TEXT/VISION → 会话型；IMAGE/VIDEO/AUDIO → 任务型）。
 * 不按 outputKind 判 —— 那边缺列的历史数据会判错。
 */
export type CallForm = 'task' | 'llm'

export function callFormFromModelType(modelType: string | null | undefined): CallForm {
  const t = (modelType || '').toUpperCase()
  return t === 'TEXT' || t === 'VISION' ? 'llm' : 'task'
}

/** MIME → 模态；MIME 缺失时按扩展名兜底（与 asset-store 上传判定同口径） */
export function kindFromMime(mime: string | null | undefined, fileName?: string): MediaKind | null {
  if (mime) {
    const matched = MEDIA_KIND_LIST.find((k) => mime.startsWith(MEDIA_MIME_PREFIXES[k]))
    if (matched) return matched
  }
  return kindFromUrl(fileName)
}

/** URL 扩展名 → 模态；用于从结果链接反推（上游外链只有 URL 没有 MIME 时） */
export function kindFromUrl(url: string | null | undefined): MediaKind | null {
  if (!url) return null
  const clean = url.split('?')[0].split('#')[0].toLowerCase()
  const byExt = MEDIA_KIND_LIST.find((k) => MEDIA_EXT[k].some((ext) => clean.endsWith(ext)))
  if (byExt) return byExt
  // 兜底：上游常给「无扩展名的内容端点」，如 Metaso 视频
  //   https://media.example.invalid/video_generation/<id>/content?expires=…
  // 路径里带模态关键词时据反推，否则 true 的 URL 会在调用记录里被当成「无产物」。
  // 用路径段关键词而不是任意子串匹配（避免 ?file=video 这类查询参数误判）。
  const m = /(?:^|\/)(image|images|video|videos|audio|audios)(?:[_\-.]|$|\/)/.exec(clean)
  if (m) {
    const w = m[1].replace(/s$/, '')
    if (w === 'image' || w === 'video' || w === 'audio') return w
  }
  return null
}

/**
 * 从生成记录里按模态取 URL 字段。
 * 记录表三张、字段名各不相同（imageUrl/videoUrl/audioUrl），
 * 这是唯一需要按 kind 取值的地方，收敛在这里，调用方不用再写三元链。
 */
export function recordUrlOf(kind: MediaKind, record: Record<string, unknown>): string {
  const v = record[MEDIA_KINDS[kind].recordUrlField]
  return typeof v === 'string' ? v : ''
}
