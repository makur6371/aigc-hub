import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler } from '@/lib/api-handler'
import { activeDiscount, effectivePoints } from '@/lib/pricing'
import { getFreeQuotaStatus } from '@/lib/free-quota'
import { checkFreeImagePass } from '@/lib/promotions/free-image-pass'
import { requireAuth } from '@/lib/api-handler'
import { videoBeansLabel } from '@/lib/video-capabilities'

const typeLabels: Record<string, string> = {
  TEXT: '纯语言模型',
  VISION: '多模态读图模型',
  IMAGE: '生图模型',
  VIDEO: '视频模型',
}

function buildBadges(
  type: string,
  supportsVision: boolean,
  contextWindow: number | null,
  metadata: Record<string, unknown> | null,
): string[] {
  const badges: string[] = []
  if (supportsVision) badges.push('多模态')
  if (contextWindow) {
    if (contextWindow >= 1000000) badges.push('1M+ 上下文')
    else if (contextWindow >= 200000) badges.push(`${Math.round(contextWindow / 1000)}K 上下文`)
    else badges.push(`${Math.round(contextWindow / 1000)}K 上下文`)
  }
  if (type === 'TEXT' && metadata) {
    if (metadata.think) badges.push('思考增强')
    if (metadata.functionCalling) badges.push('函数调用')
    if (metadata.jsonMode) badges.push('JSON 模式')
  }
  if (type === 'IMAGE' && metadata) {
    const modes = metadata.modes as string[] | undefined
    if (modes?.includes('singleImage')) badges.push('图片编辑')
    if (modes?.includes('multiReference')) badges.push('多图参考')
    if (modes?.includes('text')) badges.push('文生图')
  }
  if (type === 'VIDEO' && metadata) {
    const audio = metadata.audio as string | boolean | undefined
    if (audio === true || audio === 'optional') badges.push('音频生成')
    badges.push('视频生成')
  }
  return badges
}

export const GET = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const models = await prisma.modelConfig.findMany({
    // isPublic：只对外展示的模型。用户端模型列表与 /model-pricing 价格页口径必须一致，
    // 否则会出现「列表里选得到、价格页查不到」或反过来的割裂。
    where: { isActive: true, isPublic: true, provider: { isActive: true } },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  })

  // 每日免费额度余量：登录用户才查（匿名只返回配置上限，不查用量）
  let userId: string | null = null
  try {
    const auth = await requireAuth(request)
    userId = auth.userId
  } catch { /* 未登录：只展示额度配置，不展示剩余 */ }

  const promoUser = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { freeImageUntil: true } }).catch(() => null)
    : null

  const quotaByModel = new Map<string, number>()
  if (userId) {
    const quotaModels = models.filter((m) => (m.dailyUserFreeQuota ?? 0) > 0)
    await Promise.all(quotaModels.map(async (m) => {
      const st = await getFreeQuotaStatus(m, userId!)
      quotaByModel.set(m.id, st.remaining)
    }))
  }

  // 时长券覆盖的模型：有效期内且今天没超过后台配置的限额才算「免费」。
  // 必须异步判定（限额实时读配置/台账），否则角标会显示免费、实际扣费。
  const promoFreeIds = new Set<string>()
  if (userId && promoUser) {
    await Promise.all(models.map(async (m) => {
      const pass = await checkFreeImagePass(
        { id: m.id, type: m.type, dailyUserFreeQuota: m.dailyUserFreeQuota },
        promoUser,
        userId!,
      )
      if (pass.free) promoFreeIds.add(m.id)
    }))
  }

  return models.map((m) => {
    const promoFree = promoFreeIds.has(m.id)
    // 折扣一律走 activeDiscount（限时活动价的窗口判断唯一入口），禁止直接读 m.discount
    const discount = activeDiscount(m)
    const eff = effectivePoints(m.costPoints, discount, m.isFree)
    const unit = m.pricingType === 'PER_TOKEN' ? '积分/Token' : '积分/次'
    const quotaRemaining = quotaByModel.get(m.id)
    const quotaBadge = (m.dailyUserFreeQuota ?? 0) > 0
      // 疯狂模式（2026-11-09）：免费模型只展示「免费使用」，不暴露剩余张数
      ? ['免费使用']
      : []
    // 保留一位小数：0.75 是「7.5折」，四舍五入成「8折」会让用户以为折扣比实际小
    const promoBadge = m.isFree ? ['免费'] : discount != null ? [`${Math.round(discount * 100) / 10}折`] : []
    // 视频三种计价形态都要覆盖（一口价 / perSecondBeans / perSecondByResolution）；
    // 过去只认 videoCost，按秒计价的模型显示「? 豆/次」（真实事故 2026-11-08）。
    const videoPricingLabel = m.type === 'VIDEO'
      ? (m.isFree ? '免费' : videoBeansLabel(m.videoCost, m.metadata as Record<string, unknown> | null) ?? '按秒计费')
      : null

    return {
      id: m.id,
      name: m.name,
      modelName: m.modelName || m.name,
      type: m.type,
      typeLabel: typeLabels[m.type] || m.type,
      pricingType: m.pricingType,
      costPoints: m.costPoints,
      videoCost: m.videoCost,
      discount,
      isFree: m.isFree,
      dailyUserFreeQuota: m.dailyUserFreeQuota,
      dailyPlatformFreeQuota: m.dailyPlatformFreeQuota,
      freeQuotaRemaining: promoFree ? Math.max(quotaByModel.get(m.id) ?? 0, 1) : (quotaByModel.get(m.id) ?? null),
      promoFreeImage: promoFree,
      effectiveCostPoints: eff,
      // 三列展示用：原价 / 折后价 / 折扣率（前端据此渲染「原价 → 现价」与「几折」高亮）
      listPoints: m.costPoints,
      effectivePoints: eff,
      // 折扣率按「实付/原价」回算，而不是直接用配置值：
      // 积分是整数，配置 6 折 × 6 积分 = 3.6 → 取整 4，实际是 6.7 折。
      // 用回算值展示才能和旁边的现价对得上（否则用户看到「6折」却付了 4 积分，对不上账）。
      discountRatio: m.isFree
        ? 0
        : (discount != null && m.costPoints > 0 && eff < m.costPoints
            ? eff / m.costPoints
            : null),
      unitLabel: unit,
      pricingLabel: videoPricingLabel || (m.isFree ? '免费' : discount != null ? `原${m.costPoints} → ${eff} ${unit}` : `${m.costPoints} ${unit}`),
      supportsVision: m.supportsVision || m.type === 'VISION',
      contextWindow: m.contextWindow,
      metadata: m.metadata,
      badges: [...buildBadges(m.type, m.supportsVision || m.type === 'VISION', m.contextWindow, m.metadata as Record<string, unknown> | null), ...promoBadge, ...quotaBadge],
    }
  })
})
