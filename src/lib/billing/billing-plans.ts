// 计费方案注册表：收敛"模型类型 → 币种 → 单次计价（含 tier 档位差价）"的分发决策。
// 预算预扣、节点执行、前端预估各处都应调到这里的统一函数，避免账目口径分叉。
import { activeDiscount, effectivePoints, roundPoints } from '@/lib/pricing'
import { decodeSize } from '@/lib/image-sizes'

// 记账来源标签：null=真实扣款/退款（wallet 动了余额）；'canvas-node'=画布节点内部记账（预算池内，不动余额）
export const CATEGORY_REAL = null
export const CATEGORY_CANVAS_NODE = 'canvas-node'

// 计价所需的最小模型信息（避免依赖完整 Prisma 模型，便于预算/执行/前端共用）
export interface BillingModel {
  costPoints: number // 原始积分价（未打折，由 effectivePoints 统一折算）
  videoCost?: number | null // 视频豆价
  discount?: number | null
  isFree?: boolean
  metadata?: Record<string, unknown> | null
}

/**
 * 解析某档位的原始单价（未打折）。
 *
 * 优先级：该档位专属价 → 1K 价（作为「参考价」兜底）→ costPoints（统一单价）。
 * 这样「只填了 1K」的模型在 2K/4K 下会沿用 1K 的价格，而不是掉回统一单价或 0。
 */
export function resolveTierCost(model: BillingModel, tier?: string | null): number {
  const meta = model.metadata ?? {}
  const pick = (t: string): number | null => {
    const v = meta[`tierCost${t}`]
    return typeof v === 'number' && v >= 0 ? v : null
  }
  if (tier) {
    const exact = pick(tier)
    if (exact != null) return exact
  }
  // 1K 视作参考价：其它档位没单独定价时沿用它
  const ref = pick('1K')
  if (ref != null) return ref
  return Number(model.costPoints) || 0
}

// 生图节点按所选档位计价：宽高解出档位 → resolveTierCost。
// 与节点执行 executeImageGenerate 的档位差价语义保持一致（这才是真实的单次应扣积分）。
export function resolveImageCharge(model: BillingModel, width?: number, height?: number): number {
  const tier = width && height ? decodeSize(`${width}x${height}`)?.tier : undefined
  return effectivePoints(resolveTierCost(model, tier), activeDiscount(model), model.isFree)
}

// 按秒计价的音频积分（metadata.perSecondCost，积分/秒）：配置了则 duration × 单价；未配返回 null（回退按次）。
export function resolvePerSecondPoints(model: BillingModel, durationSec?: number): number | null {
  const meta = model.metadata ?? {}
  const per = meta.perSecondCost
  if (typeof per !== 'number' || per <= 0) return null
  const sec = safeSeconds(durationSec)
  return effectivePoints(per * sec, activeDiscount(model), model.isFree)
}

// 按秒计价的视频豆（metadata.perSecondBeans，豆/秒）：配置了则 duration × 单价；未配返回 null（回退 videoCost 一口价）。
export function resolvePerSecondBeans(model: BillingModel, durationSec?: number): number | null {
  const meta = model.metadata ?? {}
  const per = meta.perSecondBeans
  if (typeof per !== 'number' || per <= 0) return null
  const sec = safeSeconds(durationSec)
  return roundPoints(per * sec)
}

/**
 * 视频计费因子（豆）。可组合，覆盖「按次 / 按输出秒 / 按输入素材」及任意叠加。
 *
 * 为什么要因子制：各家视频上游的计费口径差异很大（见 docs/DEV_HANDOFF 的视频对比）：
 *   - 按次一口价（¥5.50/次）
 *   - 按输出秒（¥0.36/秒）
 *   - 按输入图张数（超出部分 ¥0.05/张）
 *   - 按输入音频/视频秒数
 *   - 组合（起步价 + 按秒）
 * 原实现只有 perSecondBeans（按输出秒）或 videoCost（按次）二选一，表达不了组合与输入侧。
 * 这里用「因子集合」声明，planNodeCharge 只负责求和 —— 加新口径 = 改 metadata，不改代码。
 */
export interface VideoBillingSpec {
  /** 起步价/按次价（豆） */
  perCall?: number
  /** 按输出时长（豆/秒） */
  perOutputSecond?: number
  /**
   * 按「分辨率档」区分的每秒价（豆/秒）。键为 canonical 档位（480P/720P/768P/1080P/2K/4K）。
   *
   * 不同清晰度可以设置不同单价，
   * 用一个 perOutputSecond 表达不了「1080P 更贵」。命中该档位时**优先于** perOutputSecond，
   * 未命中则回退 perOutputSecond（所以「只填一个基准价 + 少数档位单独定价」也能工作）。
   */
  perSecondByResolution?: Record<string, number>
  /** 按输入图片数量（豆/张） */
  perInputImage?: number
  /** 按输入音频时长（豆/秒） */
  perInputAudioSecond?: number
  /** 按输入视频时长（豆/秒） */
  perInputVideoSecond?: number
  /**
   * 按「输出分辨率档」区分的输入视频价（豆/秒）。
   *
   * 命中该档位时优先于 perInputVideoSecond；未命中回退单值。
   */
  perInputVideoSecondByResolution?: Record<string, number>
}

/** 计费因子所需的「实测量」——各调用方按已知信息传入，缺省按 0 计 */
export interface VideoBillingInputs {
  durationSec?: number
  imageCount?: number
  audioSeconds?: number
  videoSeconds?: number
  /** 分辨率档（canonical，如 768P）；用于按档位定价 */
  resolution?: string
}

/** 读取模型声明的视频计费规格（metadata.video.billing）；未声明返回 null */
export function resolveVideoBillingSpec(model: BillingModel): VideoBillingSpec | null {
  const meta = model.metadata ?? {}
  const video = meta.video as { billing?: VideoBillingSpec } | undefined
  const billing = video?.billing
  if (!billing || typeof billing !== 'object') return null
  return billing
}

/**
 * 算一次视频生成的豆价。优先级：
 *   1) metadata.video.billing 因子制（可组合，含输入侧）
 *   2) metadata.perSecondBeans（按输出秒，旧字段，向后兼容）
 *   3) videoCost（按次一口价，旧字段）
 * 三者都没有 → 0（由调用方按「未配置豆价」处理）。
 */
/**
 * 「秒数」安全化：只接受有限正数，其余归 1（最短 1 秒）。
 *
 * 为什么必须做：`Math.ceil(Infinity)` = Infinity，而 `roundPoints(Infinity)` = 0 ——
 * 按秒计费的模型传 `duration: 1e999`（合法 JSON，解析成 Infinity）会**算出 0 豆**，
 * 用户白嫖一次视频；NaN 同理。把非有限值当 1 秒是最保守的选择（宁可少扣也不放走 0）。
 */
function safeSeconds(s?: number): number {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 1
  return Math.max(1, Math.ceil(s))
}

export function resolveVideoBeans(model: BillingModel, inputs: VideoBillingInputs = {}): number {
  const spec = resolveVideoBillingSpec(model)
  if (spec) {
    // 与 safeSeconds 同口径：非有限/非正值按最短 1 秒计，绝不归 0（否则按秒模型会被免费）
    const seconds = (s?: number) => safeSeconds(s)
    let total = 0
    total += Number(spec.perCall) || 0
    // 分辨率档位价优先：命中该档就用档位价，否则回退统一每秒价。
    // 大小写不敏感（配置端/上游可能是 768p 或 768P）。
    const resKey = inputs.resolution ? String(inputs.resolution).toLowerCase() : ''
    const pickByResolution = (table: Record<string, number> | undefined, fallback?: number): number => {
      let rate = Number(fallback) || 0
      if (resKey && table && typeof table === 'object') {
        for (const [k, v] of Object.entries(table)) {
          if (String(k).toLowerCase() === resKey && typeof v === 'number' && v >= 0) { rate = Number(v); break }
        }
      }
      return rate
    }
    const perSecond = pickByResolution(spec.perSecondByResolution, spec.perOutputSecond)
    total += perSecond * seconds(inputs.durationSec)
    total += (Number(spec.perInputImage) || 0) * Math.max(0, Math.floor(inputs.imageCount ?? 0))
    // 输入侧素材费：**没有素材就一分钱都不加**。
    //
    // 旧写法直接 `× seconds(inputs.videoSeconds)`，而 seconds(undefined) 恒等于 1
    // （safeSeconds 把无效值当最短 1 秒）—— 于是「纯文生视频」也被收了 1 秒参考视频费。
    // 2026-11-09 修正：只有真的传了参考视频/音频才计输入费。
    const inputAudioSeconds = Number(inputs.audioSeconds ?? 0)
    if (inputAudioSeconds > 0) {
      total += (Number(spec.perInputAudioSecond) || 0) * seconds(inputAudioSeconds)
    }
    const inputVideoSeconds = Number(inputs.videoSeconds ?? 0)
    if (inputVideoSeconds > 0) {
      const perInputVideoSecond = pickByResolution(spec.perInputVideoSecondByResolution, spec.perInputVideoSecond)
      total += perInputVideoSecond * seconds(inputVideoSeconds)
    }
    // 非有限值一律归 0（不能把 Infinity/NaN 放出去）：
    // 上面 seconds() 已保证输出秒是有限值，但 spec 里若填了 Infinity/NaN 仍可能污染 total。
    if (Number.isFinite(total) && total > 0) return roundPoints(total)
    // ⚠️ spec 算不出正数时**不能直接返回 0**，必须继续走下面的兼容链。
    // 生产实锤两类「配置没配全」导致付费模型静默变免费：
    //   1) 只配了 perSecondByResolution、没配 perOutputSecond 兜底，用户选了未列出的
    //      分辨率（如 1080P）→ 档位价命中不了、perOutputSecond 也是 0 → 白嫖。
    //   2) 因子写在 spec 里但用了旧字段名（{billing:{perSecondBeans:1}}，
    //      使用旧字段时需要兼容读取。
    // 两者都是「配置没配全」而非「用户该免费」，所以必须回退旧字段口径。
    // 宁可按低档价收，也不能收 0。
  }
  // 兼容旧字段
  if (inputs.durationSec != null) {
    const per = resolvePerSecondBeans(model, inputs.durationSec)
    if (per != null) return per
  }
  const specLegacy = spec ? Number((spec as unknown as Record<string, unknown>).perSecondBeans) : NaN
  if (inputs.durationSec != null && Number.isFinite(specLegacy) && specLegacy > 0) {
    return roundPoints(specLegacy * safeSeconds(inputs.durationSec))
  }
  // 最后回退 videoCost 一口价
  return Math.max(0, model.videoCost ?? 0)
}

/**
 * 视频模型的能力约束（metadata.video.constraints）。用于**提交前**校验，
 * 避免"提交后才失败、还要退款"这种最糟体验。
 */
export interface VideoConstraints {
  /** 允许的时长（秒）：要么是离散列表，要么是区间，要么是固定值 */
  durations?: number[]
  minDuration?: number
  maxDuration?: number
  fixedDuration?: number
  /** 允许的分辨率档（厂商口径，如 '480p'/'720p'/'768P'） */
  resolutions?: string[]
  /** 允许的比例（如 '16:9'） */
  ratios?: string[]
  /** 素材数量上限 */
  maxImages?: number
  maxAudios?: number
  maxVideos?: number
  /** 是否必须提供参考图 */
  requireImage?: boolean
  /**
   * 是否必须提供参考视频 / 参考音频。
   *
   * 为什么要补这两个（2026-10-18）：`maxVideos` / `maxAudios` 表达的是**上限**，
   * 表达不了「至少要 1 个」。动作迁移工作流（wan2.2animate-v4-motion_retargeting）
   * 的语义就是「人物照 + 动作视频」—— 没有动作视频这个工作流根本不成立，
   * 但它的 constraints 只写了 `maxVideos: 1`，于是校验放行、空值直接提交给上游，
   * 用户看到的是上游的「请上传视频」，钱先扣了才失败（与 requireImage 拦住图缺失同一类问题）。
   * 补上这两个字段，「提交前拦住、给出可读原因」才成为可能。
   */
  requireVideo?: boolean
  requireAudio?: boolean
}

export function resolveVideoConstraints(model: BillingModel): VideoConstraints | null {
  const meta = model.metadata ?? {}
  const video = meta.video as { constraints?: VideoConstraints } | undefined
  const c = video?.constraints
  return c && typeof c === 'object' ? c : null
}

/**
 * 校验视频参数是否满足模型约束。返回 null 表示通过，否则返回中文错误信息。
 * 在「提交上游之前」调用，把失败挡在扣费之前（或至少给出明确原因）。
 */
export function validateVideoParams(
  model: BillingModel,
  params: { duration?: number; resolution?: string; ratio?: string; imageCount?: number; audioCount?: number; videoCount?: number },
): string | null {
  // 时长是**输入合法性**，不是模型能力约束：即使模型没配 constraints 也必须校验。
  // NaN/Infinity 不能放行 —— NaN 会让所有比较都为 false（=「通过校验」），
  // Infinity 也会绕过 maxDuration，且两者在按秒计价里曾被算成 0 豆。
  if (params.duration != null) {
    const d = params.duration
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return '时长必须是有限的正数秒'
  }

  const c = resolveVideoConstraints(model)
  if (!c) return null

  if (params.duration != null) {
    const d = params.duration
    if (c.fixedDuration != null && d !== c.fixedDuration) {
      return `该模型时长固定为 ${c.fixedDuration} 秒`
    }
    if (c.durations && c.durations.length > 0 && !c.durations.includes(d)) {
      return `该模型只支持这些时长：${c.durations.join(' / ')} 秒`
    }
    if (c.minDuration != null && d < c.minDuration) return `该模型最短 ${c.minDuration} 秒`
    if (c.maxDuration != null && d > c.maxDuration) return `该模型最长 ${c.maxDuration} 秒`
  } else if (c.fixedDuration != null) {
    // 未传但模型固定时长：交给上游默认，不拦
  }

  // 分辨率：大小写不敏感（上游/配置可能混用 768p / 768P），
  // 否则用户选 768P、配置写 768p 会被误判为「不支持」。
  if (params.resolution && c.resolutions && c.resolutions.length > 0) {
    const want = String(params.resolution).toLowerCase()
    if (!c.resolutions.some((r) => String(r).toLowerCase() === want)) {
      return `该模型只支持这些分辨率：${c.resolutions.join(' / ')}`
    }
  }
  // 比例
  if (params.ratio && c.ratios && c.ratios.length > 0 && !c.ratios.includes(params.ratio)) {
    return `该模型只支持这些比例：${c.ratios.join(' / ')}`
  }

  // 素材数量
  if (c.requireImage && !(params.imageCount && params.imageCount > 0)) {
    return '该模型必须提供参考图'
  }
  if (c.requireVideo && !(params.videoCount && params.videoCount > 0)) {
    return '该模型必须提供参考视频'
  }
  if (c.requireAudio && !(params.audioCount && params.audioCount > 0)) {
    return '该模型必须提供参考音频'
  }
  // 上限判定：maxN === 0 视为「不声明上限」，而不是「上限是 0」。
  //
  // 为什么（2026-10-18）：首尾帧工作流历史上写的是 `maxImages: 0`，本意是
  // 「这张工作流不收 referenceImages 多图口」（它走 first_frame/last_frame 专用字段），
  // 但 0 被当成「最多 0 张」→ 只要用户给了首尾帧就报「最多 0 张参考图」，
  // 工作流从来跑不通。而 `requireImage: true` 已经表达了「图是必需的」，
  // 上限 0 与它自相矛盾。约定：**上限为 0 = 不限制**，要禁止就写 maxImages: 1。
  const overLimit = (count: number | undefined, max: number | undefined, unit: string) =>
    max != null && max > 0 && (count ?? 0) > max ? `最多 ${max} ${unit}` : null
  const imgErr = overLimit(params.imageCount, c.maxImages, '张参考图')
  if (imgErr) return imgErr
  const audErr = overLimit(params.audioCount, c.maxAudios, '段参考音频')
  if (audErr) return audErr
  const vidErr = overLimit(params.videoCount, c.maxVideos, '段参考视频')
  if (vidErr) return vidErr
  return null
}

/**
 * 按模型类型分发币种并返回单次应扣价（预算预扣与节点记账都走这里，保证同口径）。
 * 视频→豆（videoCost 一口价）；图片→积分（档位价；**宽高缺省时回落 1K 参考价**，
 * 不是 `costPoints` 统一价 —— 实测行为由 tests/billing-plans.test.ts 锁定，
 * 旧注释写「按统一价」是误导，台账 Q-410）；其余（LLM/视觉/音频）→积分统一价。
 */
export function planNodeCharge(
  modelType: string,
  model: BillingModel,
  inputs?: VideoBillingInputs & { width?: number; height?: number } | null
): { points: number; beans: number } {
  if (modelType === 'VIDEO') {
    if (model.isFree) return { points: 0, beans: 0 }
    // 视频豆价统一走因子制（resolveVideoBeans）：支持按次 / 按输出秒 / 按输入素材 / 组合。
    // 预扣预算、charge-run、画布实扣三处都调这里，口径唯一（历史 bug：预算只认 videoCost）。
    const beans = resolveVideoBeans(model, inputs ?? {})
    // 活动折扣（限时/常态）对视频豆同样生效：与积分的 activeDiscount 同一窗口判定。
    const discount = activeDiscount(model)
    const finalBeans = discount != null ? roundPoints(beans * discount) : beans
    return { points: 0, beans: finalBeans > 0 ? finalBeans : 0 }
  }
  const points =
    modelType === 'IMAGE'
      ? resolveImageCharge(model, inputs?.width ?? 0, inputs?.height ?? 0)
      : effectivePoints(model.costPoints, activeDiscount(model), model.isFree)
  return { points, beans: 0 }
}

/**
 * 把「节点 inputs 原始值」规整成 planNodeCharge 的计费因子。
 *
 * 为什么必须有这个函数（真实事故）：预扣、预估、节点实扣三处各自手搓一份
 * `planNodeCharge(..., { durationSec: ..., imageCount: ... })`，谁少传一个字段就静默按
 * 「低档价」计费。2026-10-15 生产事故即如此：预扣（mcp/executor）**漏传 resolution**，
 * 于是 15 秒 768P 的任务预扣**直接算成 0 豆**、节点实扣收 300 豆，
 * 300 豆差额被「多退少不补」静默吃掉 —— 用户白嫖，真实扣款流水一条都没有。
 *
 * 单一入口 = 单一口径：新增计费因子只需改这里，四处调用自动同步。
 */
export function nodeChargeInputs(inputs: Record<string, unknown> | null | undefined): VideoBillingInputs & {
  width?: number
  height?: number
} {
  const raw = inputs ?? {}
  const finite = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // 按秒计价的因子只接受有限正数：0/负数/NaN/Infinity 都必须退化，
  // 否则预算与实扣会在脏值上悄悄错开（safeSeconds 把 Infinity 折成 1 秒、0 折成 1 秒）。
  const positiveFinite = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const refInput = raw.referenceImage
  return {
    width: finite(raw.width),
    height: finite(raw.height),
    durationSec: positiveFinite(raw.duration),
    // 分辨率档位：原样透传字符串，档位匹配在 resolveVideoBeans 内做大小写不敏感比较
    resolution:
      raw.resolution != null && String(raw.resolution).trim() !== '' ? String(raw.resolution) : undefined,
    // 输入图片数：与 canvas-executor 提交给上游的张数口径一致（跨端口去重后）
    imageCount: Array.isArray(refInput)
      ? refInput.length
      : refInput != null && String(refInput) !== ''
        ? 1
        : raw.image != null
          ? 1
          : 0,
    // （多段合计向上取整，safeSeconds 已做 ceil）。时长来源是视频上传节点的 duration 输入；
    // 未声明时按时长未知处理（每段按 safeSeconds 最短 1 秒计，宁可多收不白嫖）。
    videoSeconds: (() => {
      const vids = Array.isArray(raw.referenceVideo)
        ? raw.referenceVideo.map(String)
        : (raw.referenceVideo != null && String(raw.referenceVideo) !== '' ? [String(raw.referenceVideo)] : [])
      if (vids.length === 0) return undefined
      // 节点 inputs 上没有每段视频的时长元数据；上游按「合计时长 ceil」计费，
      // 这里用「每段 ≥1 秒」的下界保证预扣非零（实扣侧以 durationSec 与上游结算为准）。
      return vids.length
    })(),
  }
}
