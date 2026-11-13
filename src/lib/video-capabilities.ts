// 视频模型能力读取（与图片模型的 metadata.sizes 同思路）。
//
// 图片模型：配置里勾选「可用比例 + 分辨率档位」→ 使用端按所选模型过滤选项。
// 视频模型同理：配置里声明「支持的比例 / 分辨率 / 时长范围 / 素材上限」，
// 使用端（工具面板 / 画布 / Agent 偏好）在选了模型之后，只给出该模型支持的选项，
// 避免用户挑了个上游不支持的规格，提交后才失败。
//
// 数据落点：model.metadata.video.constraints（见 lib/billing/billing-plans 的 VideoConstraints）。
// 本文件只做「读 + 兜底」，不引入 billing 依赖，供前端组件共用。

export interface VideoCapabilities {
  /**
   * 生成方式（2026-11-08 面板第二步）：
 *   text = 文生视频 / firstLastFrame = 首尾帧 / multiReference = 全能参考
 *
 * 「全能参考」在 2026-11-09 改名（原「多图参考」）：同一方式在不同供应商下
 * 支持的材料不同（有的只收图，有的图+音频，有的图+音频+视频），不能写死成"多图"。
 * 素材口仍由 constraints.maxImages / maxAudios / maxVideos 决定，
 * 面板只渲染该模型真正支持的输入框。
   * 声明 ≥2 种 → 面板在选模型后渲染「生成方式」选择器，输入框跟随方式显隐；
   * 未声明 / 只声明一种 → 不显示选择器（保持单形态工具的现状）。
   * 与生图模型的 metadata.modes 同思路，落点：metadata.video.modes。
   */
  modes: string[]
  ratios: string[]
  resolutions: string[]
  /** 离散可选时长（秒）；空数组表示用区间 */
  durations: number[]
  minDuration?: number
  maxDuration?: number
  fixedDuration?: number
  maxImages?: number
  maxAudios?: number
  maxVideos?: number
  requireImage?: boolean
  /** 必填素材（2026-10-18 补）：maxVideos/maxAudios 只是上限，表达不了「至少 1 个」 */
  requireVideo?: boolean
  requireAudio?: boolean
  /**
   * 时长是否可选。上游工作流不收 duration（如动作迁移）时显式声明 false，
   * 面板把「时长」行整个藏掉 —— 否则会显示一堆发了也无效的秒数选项。
   */
  durationSelectable: boolean
}

/** 生成方式的 canonical 值与面板文案（与 metadata.video.modes 对应） */
export const VIDEO_MODE_LABELS: Record<string, string> = {
  text: '文生视频',
  firstLastFrame: '首尾帧',
  multiReference: '全能参考',
}

/** 展示顺序（用户口径：文生视频 → 首尾帧 → 全能参考），与 DB 里 modes 的存储顺序解耦 */
export const VIDEO_MODE_ORDER = ['text', 'firstLastFrame', 'multiReference']

export function sortVideoModes(modes: string[]): string[] {
  return [...modes].sort((a, b) => {
    const ia = VIDEO_MODE_ORDER.indexOf(a)
    const ib = VIDEO_MODE_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/**
 *
 * 视频计价有三种配置形态，展示必须全部覆盖：
 *   1. videoCost 一口价（豆/次）
 *   2. metadata.perSecondBeans（豆/秒，不区分分辨率）
 *   3. metadata.video.billing.perSecondByResolution（豆/秒，按分辨率档）
 * 过去 2/3 没配 videoCost 时展示层直接显示「免费」，实际跑一次按秒扣几十豆 ——
 * 价格页（model-pricing-catalog）算的是对的，只有选择器这里漏了第 3 种。
 */
export function videoBeansLabel(
  videoCost: number | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  /** 活动折扣（0~1）；有值时按折后价展示并带「折」后缀 */
  discount?: number | null,
): string | null {
  // 折扣是对「总额」生效，所以展示上只加一个折扣后缀；
  // 不能对组合标签的第一个数字打折（「18 豆/次 + 18 豆/秒」会只折到前半段）。
  const hasDiscount = discount != null && discount > 0 && discount < 1
  const withDiscount = (label: string): string =>
    hasDiscount ? `${label} · ${Math.round(discount! * 100) / 10}折` : label
  // 组件价按折后展示（与旧版「14 豆/秒起·7.5折」一致）；折扣后缀保留，便于核对原价
  const price = (n: number): string => String(hasDiscount ? Math.round(n * discount!) : n)

  const video = (metadata?.video ?? {}) as Record<string, unknown>
  const billing = (video.billing ?? {}) as Record<string, unknown>
  // 没有因子制 spec 时才看旧字段 —— 配了 spec 后引擎会忽略 videoCost / perSecondBeans，
  // 展示必须同口径，否则后台改价后模型卡还显示旧价。
  if (Object.keys(billing).length === 0) {
    if (videoCost != null && videoCost > 0) return withDiscount(`${price(videoCost)} 豆`)
    const legacy = typeof metadata?.perSecondBeans === 'number' && metadata.perSecondBeans > 0
      ? metadata.perSecondBeans
      : null
    if (legacy) return withDiscount(`${price(legacy)} 豆/秒`)
    return null
  }
  // 只显示按秒会把固定部分藏掉，用户按秒数估算就会偏低。
  const parts: string[] = []
  const perCall = Number(billing.perCall)
  if (Number.isFinite(perCall) && perCall > 0) parts.push(`${price(perCall)} 豆/次`)
  const flatSec = Number(billing.perOutputSecond)
  const perRes = billing.perSecondByResolution
  let rateLabel: string | null = null
  if (perRes && typeof perRes === 'object') {
    const rates = Object.values(perRes)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (rates.length > 0) rateLabel = `${price(Math.min(...rates))} 豆/秒起`
  }
  if (!rateLabel && Number.isFinite(flatSec) && flatSec > 0) rateLabel = `${price(flatSec)} 豆/秒`
  if (rateLabel) parts.push(rateLabel)
  if (parts.length > 0) return withDiscount(parts.join(' + '))
  return null
}

/** 视频比例兜底集合（模型未声明时用；覆盖常见横竖方） */
export const DEFAULT_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

/**
 * 视频分辨率**对外统一口径**：一律大写 P（480P / 720P / 768P / 1080P），
 * 2K / 4K 用大写 K。
 *
 * 与用户下拉里，同一个「768」在三个地方三种写法，用户看到「没有 720P」或
 * 「写的是 768 不是 768P」。统一到本模块归一，adapter 再翻译成各自上游写法。
 */
export const VIDEO_RES_TIERS = ['480P', '720P', '768P', '1080P', '2K', '4K'] as const

/** 视频分辨率兜底集合（模型未声明时用） */
export const DEFAULT_VIDEO_RESOLUTIONS = ['480P', '720P', '1080P']

/**
 * 把任意口径的档位标签归一到 canonical（大小写）。
 * 768p → 768P；2k/2K → 2K；1080p → 1080P；未知值原样返回。
 */
export function normalizeVideoResolution(res?: string | null): string {
  if (!res) return ''
  const s = String(res).trim()
  if (!s) return ''
  const m = /^(\d+)\s*[pP]$/.exec(s)
  if (m) return `${m[1]}P`
  const k = /^(\d+)\s*[kK]$/.exec(s)
  if (k) return `${k[1]}K`
  return s
}

interface ModelLike {
  metadata?: Record<string, unknown> | null
}

/** 读模型声明的视频能力；未声明时给出兜底（不限制时返回空数组由调用方决定） */
export function getVideoCapabilities(model: ModelLike | undefined | null): VideoCapabilities {
  const meta = (model?.metadata ?? {}) as Record<string, unknown>
  const video = (meta.video ?? {}) as Record<string, unknown>
  const c = (video.constraints ?? {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])
  const durations = Array.isArray(c.durations)
    ? c.durations.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : []
  return {
    modes: arr(c.modes),
    ratios: arr(c.ratios),
    resolutions: arr(c.resolutions),
    durations,
    minDuration: typeof c.minDuration === 'number' ? c.minDuration : undefined,
    maxDuration: typeof c.maxDuration === 'number' ? c.maxDuration : undefined,
    fixedDuration: typeof c.fixedDuration === 'number' ? c.fixedDuration : undefined,
    maxImages: typeof c.maxImages === 'number' ? c.maxImages : undefined,
    maxAudios: typeof c.maxAudios === 'number' ? c.maxAudios : undefined,
    maxVideos: typeof c.maxVideos === 'number' ? c.maxVideos : undefined,
    requireImage: c.requireImage === true,
    requireVideo: c.requireVideo === true,
    requireAudio: c.requireAudio === true,
    durationSelectable: c.durationSelectable !== false,
  }
}

/**
 * 视频模型的「素材口」解析结果 —— 工具面板据此决定显示哪些上传框、必填还是选填。
 *
 * ===== 为什么要这个（2026-10-18 用户报的问题）=====
 * 原来上传槽是**工具级写死**的：每个视频工具的 slots 里固定塞了 audioSlot + videoSlot，
 * 于是面板与模型能力脱节 —— 选了「多图参考生视频」这种不收视频的模型，面板照样显示
 * 「参考视频」框；选了「动作迁移」这种视频必填的模型，面板却把它标成「可选」。
 * 用户只能提交后才知道对不对。
 *
 * 现在上传口**跟随模型**，与比例/分辨率档位完全同一套机制：
 *   · 模型声明 maxVideos>0 / maxAudios>0 → 展示该上传框
 *   · requireVideo / requireAudio → 该框标为**必填**并先校验
 *   · 模型完全不支持（上限 0 且未声明 require）→ **不展示**
 *
 * 判据要区分两种「不支持」：
 *   - maxN 显式为 0 且没有 require → 该模态被关掉（首尾帧工作流：maxAudios:0/maxVideos:0）
 *   - maxN/require 都没声明 → 未配置，按**允许**处理（保守：宁可多给一个框，
 *     也别把用户需要的素材口藏起来；真正拦不住的地方由 validateVideoParams 兜底）
 */
export interface VideoMediaSlots {
  /** 是否展示参考图上传框 */
  image: boolean
  imageRequired: boolean
  imageMax: number
  /** 是否展示参考音频上传框 */
  audio: boolean
  audioRequired: boolean
  audioMax: number
  /** 是否展示参考视频上传框 */
  video: boolean
  videoRequired: boolean
  videoMax: number
}

export function resolveVideoMediaSlots(cap: VideoCapabilities): VideoMediaSlots {
  const off = (max: number | undefined, required: boolean | undefined) =>
    // 显式 0 且非必填 → 该模态关闭；其余（含未声明）都算开启
    max !== 0 || required === true
  return {
    image: off(cap.maxImages, cap.requireImage),
    imageRequired: cap.requireImage === true,
    imageMax: cap.maxImages && cap.maxImages > 0 ? cap.maxImages : 1,
    audio: off(cap.maxAudios, cap.requireAudio),
    audioRequired: cap.requireAudio === true,
    audioMax: cap.maxAudios && cap.maxAudios > 0 ? cap.maxAudios : 1,
    video: off(cap.maxVideos, cap.requireVideo),
    videoRequired: cap.requireVideo === true,
    videoMax: cap.maxVideos && cap.maxVideos > 0 ? cap.maxVideos : 1,
  }
}

/**
 * 「全能参考」支持哪些素材 —— 给用户看的一句话（如「图 9 · 音 3 · 视频 3」）。
 * 不同供应商能力不同，选择器上必须把这个差异显式说出来。
 */
export function describeVideoMediaSlots(media: VideoMediaSlots): string {
  const parts: string[] = []
  if (media.image) parts.push(`图 ${media.imageMax}`)
  if (media.audio) parts.push(`音 ${media.audioMax}`)
  if (media.video) parts.push(`视频 ${media.videoMax}`)
  return parts.length > 0 ? parts.join(' · ') : '仅提示词'
}

export function videoMediaKindForUploadPort(port: string): 'image' | 'audio' | 'video' | undefined {
  if (port === 'referenceVideo' || port === 'video') return 'video'
  if (port === 'referenceAudio' || port === 'audio') return 'audio'
  if (port === 'referenceImage' || port === 'image' || port === 'images') return 'image'
}

/**
 * 上传槽在当前生成方式下是否生效。
 *
 * 唯一口径（面板 / 创作器 / 必填校验共用），避免三处各写一遍：
 *   · 文生视频：只保留提示词 → 所有素材口隐藏
 *   · 首尾帧：只保留首帧/尾帧（由 videoModeOnly 标注）
 *   · 全能参考：按模型能力显示 图 / 音频 / 视频
 *   · 模型未声明方式（单形态工具）：维持旧行为，不按方式过滤
 */
export function slotVisibleInVideoMode(
  slot: { type: string; videoModeOnly?: string; targets?: Array<{ port?: string }> },
  videoMode: string | undefined,
  media: VideoMediaSlots | null,
): boolean {
  if (slot.type !== 'upload') return true
  if (!videoMode) return true
  const port = slot.targets?.[0]?.port ?? ''
  const isFramePort = port === 'firstFrame' || port === 'lastFrame'
  if (slot.videoModeOnly && slot.videoModeOnly !== videoMode) return false
  if (videoMode === 'firstLastFrame') return isFramePort || slot.videoModeOnly === videoMode
  if (videoMode !== 'multiReference') return false
  const kind = videoMediaKindForUploadPort(port)
  return kind ? !!media?.[kind] : slot.videoModeOnly === videoMode
}

/**
 * 该模型是否出现在通用「视频模型」选择器里。
 *
 * 数字人对口型 / 动作迁移这类工作流被固定在专属工具里（工具面板里模型槽是 hidden），
 * 放进通用视频选择器只会让用户选到不适配「文生 / 首尾帧 / 全能参考」的模型。
 * 后台用「专属工具」开关标记（metadata.video.exclusiveTool=true）。
 */
export function isSelectableVideoModel(model: {
  type?: string
  metadata?: Record<string, unknown> | null
}): boolean {
  if (model.type && model.type !== 'VIDEO') return true
  const video = (model.metadata?.video ?? {}) as Record<string, unknown>
  return video.exclusiveTool !== true
}

/** 该比例是否被模型支持（模型未声明比例时视为支持全部） */
export function videoSupportsRatio(cap: VideoCapabilities, ratio: string): boolean {
  return cap.ratios.length === 0 || cap.ratios.includes(ratio)
}

/** 解析出可选时长列表：离散 > 区间展开（步长 1，上限 60 防爆）> 兜底 */
export function resolveVideoDurations(cap: VideoCapabilities): number[] {
  if (cap.fixedDuration) return [cap.fixedDuration]
  if (cap.durations.length > 0) return [...cap.durations].sort((a, b) => a - b)
  if (cap.minDuration != null && cap.maxDuration != null) {
    const out: number[] = []
    for (let d = cap.minDuration; d <= cap.maxDuration && out.length < 60; d++) out.push(d)
    return out
  }
  return [5, 10, 15]
}

/**
 * 是否用拖动条：连续整数区间且档位够多（如 4–30 共 27 档）。
 * 离散档（5/10/15/30）仍用按钮 —— 拖动条在稀疏档位上反而难点准。
 */
export function isContinuousDurationRange(options: number[], fixedDuration?: number): boolean {
  if (fixedDuration != null) return false
  if (options.length < 8) return false
  const first = options[0]
  const last = options[options.length - 1]
  return last - first + 1 === options.length
}

/** 各分辨率档对应的短边像素（用于把「比例 + 档位」换算成 width×height 传给上游） */
const RES_SHORT_SIDE: Record<string, number> = {
  // 漏了它会导致「16:9 + 768P」解析不出像素 → 视频尺寸静默回退默认。
  '480p': 480, '720p': 720, '768p': 768, '1080p': 1080, '2k': 1440, '4k': 2160,
}

/**
 * 「比例 + 分辨率档」→ 像素宽高（偶数，避免部分上游拒绝奇数）。
 * 比例形如 '16:9'；档位形如 '720p'（大小写不敏感）。
 * 无法解析时返回 null，由调用方回退默认。
 */
export function resolveVideoSize(ratio: string, resolution: string): { width: number; height: number } | null {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(ratio).trim())
  if (!m) return null
  const rw = Number(m[1]), rh = Number(m[2])
  if (!rw || !rh) return null
  const short = RES_SHORT_SIDE[String(resolution).toLowerCase()]
  if (!short) return null
  // 短边设为档位值；长边按比例放大
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const width = rw >= rh ? even(short * (rw / rh)) : even(short)
  const height = rw >= rh ? even(short) : even(short * (rh / rw))
  return { width, height }
}
