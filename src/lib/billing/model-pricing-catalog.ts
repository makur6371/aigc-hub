// 模型价格目录：把 ModelConfig + metadata 里散落的定价配置，
// 归一化成一份「可直接渲染成价格表」的形状。
//
// 为什么要有这层（而不是页面里现查现算）：
//   1) 档位价藏在 metadata.tierCost1K/2K/4K、metadata.video.billing.* 里，
//      这些键名与回退规则（resolveTierCost / resolveVideoBeans）在 billing-plans 里
//      已有权威实现 —— 页面若自己再写一遍回退链，展示价就会和真实扣费价漂移；
//   2) 以后要同时给「公开价格页」「用户端模型列表」「内测对照页」用，
//      必须只有一份口径，否则调价时要改三处。
// 契约：这里的每个数字都必须能从 billing-plans 的同名字段推出来，不新增定价语义。
import { activeDiscount, effectivePoints, roundPoints } from '@/lib/pricing'
import {
  resolveTierCost,
  resolveVideoBeans,
  resolveVideoBillingSpec,
  resolvePerSecondPoints,
  resolveVideoConstraints,
  type BillingModel,
} from '@/lib/billing/billing-plans'

export type PricingCatalogRow = {
  id: string
  name: string
  type: string
  typeLabel: string
  /** 展示用的一句话计价口径，如「按次」「按 Token」「按输出秒」 */
  basisLabel: string
  /** 原价（积分）。视频模型为 null —— 视频扣豆不扣积分 */
  listPoints: number | null
  /** 现价（积分，已含模型级折扣/免费）。视频模型为 null */
  points: number | null
  discountRatio: number | null
  /** 视频：现价豆价（按次口径的展示值，实际随时长/分辨率变） */
  beans: number | null
  unit: string
  /** 生图：各清晰度档位的现价积分（1K/2K/4K） */
  tiers: { tier: string; list: number; points: number }[]
  /** 视频：按分辨率档的单价豆（来自 perSecondByResolution），空表示未单独定价 */
  videoTiers: { resolution: string; beansPerSecond: number }[]
  /**
   * 视频豆价的口径。
   *   perSecond = 按时长（每秒价 × 时长，可再叠起步价/输入素材费）
   *   perCall   = 一口价（每次固定豆数，**与时长无关**）
   *
   * 为什么必须区分：页面要回答「这个时长要多少豆」。对 perCall 模型按秒去乘，
   * 会把「2 豆/次」显示成「20 豆/10 秒」—— 价格表上凭空多出 10 倍的假账。
   * 判定直接复用 billing-plans 的口径探测，而不是猜字段名。
   */
  videoBasis: 'perSecond' | 'perCall'
  /** perCall 口径下的单次豆价 */
  perCallBeans: number
  /** 是否参与每日免费额度 */
  freeQuota: number | null
  freeQuotaMaxTier: string | null
  badges: string[]
}

const TYPE_LABELS: Record<string, string> = {
  TEXT: '纯语言模型',
  VISION: '多模态读图模型',
  IMAGE: '生图模型',
  VIDEO: '视频模型',
}

export const RES_TIER_ORDER = ['1K', '2K', '4K'] as const

/** 一行 ModelConfig（不含 provider）→ 归一化价格行 */
export function toPricingRow(m: BillingModel & { id: string; name: string; type: string; pricingType?: string | null; dailyUserFreeQuota?: number | null; supportsVision?: boolean; contextWindow?: number | null }): PricingCatalogRow {
  const meta = (m.metadata ?? {}) as Record<string, unknown>
  const isVideo = m.type === 'VIDEO'
  // 折扣一律取 activeDiscount（含时间窗判断），禁止直接读 m.discount —— 见 pricing.activeDiscount 注释
  const discount = activeDiscount(m)

  const tiers =
    m.type === 'IMAGE'
      ? RES_TIER_ORDER.map((tier) => {
          const list = roundPoints(resolveTierCost(m, tier))
          return { tier, list, points: effectivePoints(list, discount, m.isFree) }
        })
      : []

  const spec = isVideo ? resolveVideoBillingSpec(m) : null
  const videoTiers: { resolution: string; beansPerSecond: number }[] = []
  if (spec?.perSecondByResolution) {
    for (const [res, v] of Object.entries(spec.perSecondByResolution)) {
      if (typeof v === 'number' && v >= 0) videoTiers.push({ resolution: String(res).toUpperCase(), beansPerSecond: v })
    }
    videoTiers.sort((a, b) => a.beansPerSecond - b.beansPerSecond)
  }

  // 视频口径判定：只有「真的存在每秒价因子」才算按时长计价。
  // 注意 metadata.perSecondBeans 也是每秒价；videoCost / spec.perCall 是一口价。
  const hasPerSecond =
    spec?.perOutputSecond != null ||
    videoTiers.length > 0 ||
    (typeof (meta.perSecondBeans as unknown) === 'number' && (meta.perSecondBeans as number) > 0)
  const perCallBeans = roundPoints(
    m.isFree ? 0 : Number(spec?.perCall) || Number(m.videoCost) || 0
  )

  // 计价口径标签：视频优先说因子制，其次旧字段，最后一口价。
  let basisLabel = '按次'
  if (m.pricingType === 'PER_TOKEN') basisLabel = '按 Token'
  else if (isVideo) {
    if (hasPerSecond) basisLabel = '按输出秒'
    else if (resolvePerSecondPoints(m, 1) != null) basisLabel = '按时长（积分）'
    else basisLabel = '按次'
  } else if (m.type === 'AUDIO') basisLabel = meta.perSecondCost != null ? '按秒' : '按次'

  const freeQuota = m.dailyUserFreeQuota != null && m.dailyUserFreeQuota > 0 ? m.dailyUserFreeQuota : null

  const badges: string[] = []
  if (m.isFree) badges.push('免费')
  if (discount != null && !m.isFree) badges.push('促销')
  if (freeQuota) badges.push(`每日免费 ${freeQuota} 次`)
  const maxTier = meta.freeQuotaMaxTier
  if (typeof maxTier === 'string' && maxTier) badges.push(`免费额度限 ${maxTier.toUpperCase()}`)

  return {
    id: m.id,
    name: m.name,
    type: m.type,
    typeLabel: TYPE_LABELS[m.type] || m.type,
    basisLabel,
    listPoints: isVideo ? null : roundPoints(Number(m.costPoints) || 0),
    points: isVideo ? null : effectivePoints(m.costPoints, discount, m.isFree),
    discountRatio:
      m.isFree || m.costPoints <= 0 ? null
      : discount != null && effectivePoints(m.costPoints, discount, m.isFree) < m.costPoints
        ? roundPoints(effectivePoints(m.costPoints, discount, m.isFree) / m.costPoints)
        : null,
    // beans 字段保留「该模型一次生成的豆价量级」，用于价格表右侧的概览数字。
    // perSecond 模型按 1 秒展示（用户看的是单价）；perCall 模型直接展示一口价。
    beans: isVideo
      ? m.isFree
        ? 0
        : hasPerSecond
          ? roundPoints(
              Number(spec?.perOutputSecond) ||
              videoTiers[0]?.beansPerSecond ||
              Number(meta.perSecondBeans) ||
              0
            )
          : perCallBeans
      : null,
    videoBasis: isVideo ? (hasPerSecond ? 'perSecond' : 'perCall') : 'perCall',
    perCallBeans: isVideo ? perCallBeans : 0,
    unit: m.pricingType === 'PER_TOKEN' ? '积分/Token' : '积分/次',
    tiers,
    videoTiers,
    freeQuota,
    freeQuotaMaxTier: typeof maxTier === 'string' && maxTier ? maxTier.toUpperCase() : null,
    badges,
  }
}

export type PricingCatalog = {
  rows: PricingCatalogRow[]
  /** 参考生图单价（积分/张），用于「这点积分能跑几张图」换算 */
  referenceImagePoints: number
  /** 免费额度上限涉及的档位，说明免费额度有成本上限 */
  note: string
}

/**
 * 读一份完整价格目录。
 *
 * 过滤条件有三层，缺一不可：
 *   1. isActive + provider.isActive —— 技术上能跑（与 /api/models 同口径）
 *   2. isPublic —— 产品上是否对外开放（mock-*、灰度 alpha 等不对用户展示）
 * 少第 2 层，价格页就会列出 mock-llm / mock-image-pro 这类测试模型，
 * 用户完全不知道该选哪个；少了第 1 层，则会列出调不通的模型。
 */
export async function loadPricingCatalog(opts?: { providerId?: string; includeInternal?: boolean }): Promise<PricingCatalog> {
  const { getPrisma } = await import('@/lib/prisma')
  const prisma = await getPrisma()
  const models = await prisma.modelConfig.findMany({
    where: {
      isActive: true,
      provider: { isActive: true },
      ...(opts?.includeInternal ? {} : { isPublic: true }),
      ...(opts?.providerId ? { providerId: opts.providerId } : {}),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  })

  const rows = models.map((m) =>
    toPricingRow({
      id: m.id,
      name: m.name,
      type: m.type,
      pricingType: m.pricingType,
      costPoints: m.costPoints,
      videoCost: m.videoCost,
      discount: activeDiscount(m),
      isFree: m.isFree,
      metadata: m.metadata as Record<string, unknown> | null,
      dailyUserFreeQuota: m.dailyUserFreeQuota,
    })
  )

  return {
    rows,
    referenceImagePoints: 3,
    note: '价格为内测口径，可能随时调整；页面展示与实际扣费同源，调价即时生效。',
  }
}

export function findConstraintHint(m: BillingModel): string | null {
  const c = resolveVideoConstraints(m)
  if (!c) return null
  const parts: string[] = []
  if (c.fixedDuration != null) parts.push(`${c.fixedDuration} 秒`)
  else if (c.durations?.length) parts.push(`${c.durations.join('/')} 秒`)
  else if (c.minDuration != null || c.maxDuration != null) parts.push(`${c.minDuration ?? 1}~${c.maxDuration ?? '不限'} 秒`)
  if (c.resolutions?.length) parts.push(c.resolutions.join('/'))
  return parts.length ? parts.join(' · ') : null
}
