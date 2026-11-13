import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { roundPoints, toFiniteNumber, toNonNegative } from '@/lib/pricing'

// 计价字段：积分/豆支持小数（保留 2 位）——折扣后可能不足 1（如 6 × 0.1 = 0.6），
// 取整会把价格抹平成 1 或 0。metadata 档位价（tierCost1K/2K/4K）同理。
type PricingBody = {
  costPoints?: number | string | null
  videoCost?: number | string | null
  metadata?: Record<string, unknown> | null
}

/**
 * 价格字段解析：非法输入必须**报错**，不能静默变 0。
 *
 * 为什么：`roundPoints(Number('abc'))` = roundPoints(NaN) = 0，
 * 而 0 是合法价（0 >= 0 通过校验）→ 一次手滑就把模型改成免费，且无任何提示。
 * 这里把「空/未传」与「传了但非法」区分开：前者是「不改/置空」，后者 400。
 */
function parsePrice(raw: number | string | null | undefined, field: string): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new ApiHandlerError(`${field}必须是数字`, 400)
  // 负数价会被下游按 Math.max(0, ...) 夹成 0 → 等于免费，必须拒绝而不是静默变 0
  if (n < 0) throw new ApiHandlerError(`${field}不能为负数`, 400)
  return roundPoints(n)
}

function sanitizePricing(body: PricingBody) {
  let metadata: Record<string, unknown> | null = null
  if (body.metadata && typeof body.metadata === 'object') {
    metadata = { ...body.metadata }
    for (const k of Object.keys(metadata)) {
      if (/^tierCost(1K|2K|4K)$/.test(k)) {
        const v = metadata[k]
        metadata[k] = v == null || v === '' ? null : parsePrice(v as number | string, `档位价 ${k}`)
      }
    }
  }
  return {
    // 未传 / 空串 = 不改（undefined）—— 保持原有语义，绝不能把「空」当成 0（=免费）
    costPoints: body.costPoints == null || body.costPoints === '' ? undefined : parsePrice(body.costPoints, '积分单价')!,
    videoCost: parsePrice(body.videoCost, '视频豆价'),
    metadata,
  }
}

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    const prisma = await getPrisma()

    const discount = body.discount == null || body.discount === '' ? null : Number(body.discount)
    if (discount != null && !(discount > 0 && discount <= 1)) {
      throw new ApiHandlerError('折扣率需在 (0,1] 之间', 400)
    }
    // 折扣时间窗（限时活动价）：空 = 永久生效；非法字符串拒绝入库（静默变 null 会把活动价变成永久价）
    const parseWindowDate = (v: unknown): Date | null => {
      if (v == null || v === '') return null
      const d = new Date(String(v))
      if (Number.isNaN(d.getTime())) throw new ApiHandlerError('折扣时间窗格式无效', 400)
      return d
    }
    const pricing = sanitizePricing(body)
    if (pricing.costPoints != null && !(pricing.costPoints >= 0)) {
      throw new ApiHandlerError('积分单价需为非负数', 400)
    }

    const model = await prisma.modelConfig.update({
      where: { id },
      data: {
        name: body.name,
        modelName: body.modelName || '',
        type: body.type,
        pricingType: body.pricingType,
        costPoints: pricing.costPoints,
        videoCost: pricing.videoCost,
        discount,
        discountStartsAt: parseWindowDate(body.discountStartsAt),
        discountEndsAt: parseWindowDate(body.discountEndsAt),
        isFree: body.isFree ?? false,
        dailyUserFreeQuota: body.dailyUserFreeQuota == null || body.dailyUserFreeQuota === '' ? null : Math.round(toNonNegative(body.dailyUserFreeQuota)) || null,
        dailyPlatformFreeQuota: body.dailyPlatformFreeQuota == null || body.dailyPlatformFreeQuota === '' ? null : Math.round(toNonNegative(body.dailyPlatformFreeQuota)) || null,
        providerId: body.providerId,
        isActive: body.isActive,
        // 对外展示开关：缺省沿用现值（不传就别动），显式 false 才隐藏
        ...(body.isPublic === undefined ? {} : { isPublic: !!body.isPublic }),
        supportsVision: body.supportsVision ?? false,
        // NaN 不能入库：contextWindow 参与历史预算，NaN 会绕过 `> 0` 判断、链最小窗口比较也失效
        // contextWindow 参与历史预算：非法值不能静默用兜底（会导致预算算错且无提示）
        contextWindow: body.contextWindow == null || body.contextWindow === ''
          ? null
          : (() => {
              const n = toFiniteNumber(body.contextWindow, NaN)
              if (!Number.isFinite(n) || n <= 0) throw new ApiHandlerError('上下文窗口必须是正数', 400)
              return Math.round(n)
            })(),
        metadata: pricing.metadata as import('@prisma/client').Prisma.InputJsonValue | undefined,
      },
    })

    return success(
      { ...model, createdAt: model.createdAt.toISOString(), updatedAt: model.updatedAt.toISOString() },
      '更新成功'
    )
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    await prisma.modelConfig.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
