import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import {roundPoints, toFiniteNumber, toNonNegative} from '@/lib/pricing'
import { apiHandler, requireAuth } from '@/lib/api-handler'

type ModelWithProvider = Awaited<ReturnType<typeof import('@prisma/client').PrismaClient.prototype.modelConfig.findFirstOrThrow>> & {
  provider?: { id: string; name: string; code: string } | null
}

const serializeModel = (m: ModelWithProvider) => ({
  id: m.id,
  name: m.name,
  modelName: m.modelName,
  type: m.type,
  pricingType: m.pricingType,
  costPoints: m.costPoints,
  videoCost: m.videoCost,
  discount: m.discount,
  discountStartsAt: m.discountStartsAt?.toISOString() ?? null,
  discountEndsAt: m.discountEndsAt?.toISOString() ?? null,
  isFree: m.isFree,
  dailyUserFreeQuota: m.dailyUserFreeQuota,
  dailyPlatformFreeQuota: m.dailyPlatformFreeQuota,
  isActive: m.isActive,
  isPublic: m.isPublic,
  providerId: m.providerId,
  provider: m.provider,
  supportsVision: m.supportsVision,
  contextWindow: m.contextWindow,
  metadata: m.metadata,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
})

export const GET = apiHandler(async () => {
  const prisma = await getPrisma()
  const models = await prisma.modelConfig.findMany({
    // 排序：启用的在前，其次创建时间倒序（停用模型沉底，不用翻页找）
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    include: { provider: { select: { id: true, name: true, code: true } } },
  })
  return models.map(serializeModel)
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const { name, modelName, type, pricingType, costPoints, videoCost, providerId, isActive, isPublic, supportsVision, contextWindow, metadata, discount, discountStartsAt, discountEndsAt, isFree, dailyUserFreeQuota, dailyPlatformFreeQuota } = await request.json()

  if (!name || !type || !pricingType || costPoints == null || !providerId) {
    throw new Error('请填写完整信息')
  }

  // 视频计价二选一：一口价 videoCost **或** 按秒价 metadata.perSecondBeans。
  // 只填按秒价时不再强制 videoCost —— 否则管理员为了过校验得瞎填一口价，
  // 与「按秒计价」语义冲突（按秒价优先，一口价只是兜底）。
  const perSecondBeansNum =
    metadata && typeof metadata === 'object' ? Number((metadata as Record<string, unknown>).perSecondBeans) : NaN
  const hasPerSecond = Number.isFinite(perSecondBeansNum) && perSecondBeansNum > 0
  if (type === 'VIDEO' && !hasPerSecond) {
    const vc = toFiniteNumber(videoCost, NaN)
    if (!Number.isFinite(vc) || vc <= 0) {
      throw new Error('视频模型必须设置豆价（一口价或按秒价，至少其一）')
    }
  }

  const discountNum = discount == null || discount === '' ? null : Number(discount)
  if (discountNum != null && !(discountNum > 0 && discountNum <= 1)) {
    throw new Error('折扣率需在 (0,1] 之间')
  }
  // 折扣时间窗（限时活动价）：空 = 永久生效；非法字符串拒绝入库（静默变 null 会把活动价变成永久价）
  const parseWindowDate = (v: unknown): Date | null => {
    if (v == null || v === '') return null
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) throw new Error('折扣时间窗格式无效')
    return d
  }
  const discountStartsAtDate = parseWindowDate(discountStartsAt)
  const discountEndsAtDate = parseWindowDate(discountEndsAt)

  // 计价字段：积分/豆支持小数（保留 2 位），metadata 档位价（tierCost1K/2K/4K）同理。
  // 折扣后可能不足 1 积分（如 6 × 0.1 = 0.6），取整会把价格抹平。
  // 「非法数字」必须报错，不能靠 roundPoints 静默变 0 —— roundPoints(NaN)=0 且 0>=0 通过校验，
  // 等于一次手滑就把模型改成免费。所以**先判有限，再 round**（顺序反了就是死代码）。
  const costPointsRaw = toFiniteNumber(costPoints, NaN)
  if (!Number.isFinite(costPointsRaw) || costPointsRaw < 0) throw new Error('积分单价需为非负数')
  const costPointsNum = roundPoints(costPointsRaw)
  const videoCostRaw = videoCost == null || videoCost === '' ? null : toFiniteNumber(videoCost, NaN)
  if (videoCostRaw != null && (!Number.isFinite(videoCostRaw) || videoCostRaw < 0)) throw new Error('视频豆价必须是非负数')
  const videoCostNum = videoCostRaw == null ? null : roundPoints(videoCostRaw)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let metadataSanitized: any = null
  if (metadata && typeof metadata === 'object') {
    metadataSanitized = Object.fromEntries(
      Object.entries(metadata as Record<string, unknown>).map(([k, v]) => [
        k,
        /^tierCost(1K|2K|4K)$/.test(k) && v != null && v !== ''
          ? (() => {
              const n = toFiniteNumber(v, NaN)
              if (!Number.isFinite(n) || n < 0) throw new Error(`档位价 ${k} 必须是非负数`)
              return roundPoints(n)
            })()
          : v,
      ]),
    )
  }

  const prisma = await getPrisma()
  const model = await prisma.modelConfig.create({
    data: {
      name,
      modelName: modelName || '',
      type,
      pricingType,
      costPoints: costPointsNum,
      videoCost: videoCostNum,
      discount: discountNum,
      discountStartsAt: discountStartsAtDate,
      discountEndsAt: discountEndsAtDate,
      isFree: isFree ?? false,
      dailyUserFreeQuota: dailyUserFreeQuota == null || dailyUserFreeQuota === '' ? null : Math.round(toNonNegative(dailyUserFreeQuota)) || null,
      dailyPlatformFreeQuota: dailyPlatformFreeQuota == null || dailyPlatformFreeQuota === '' ? null : Math.round(toNonNegative(dailyPlatformFreeQuota)) || null,
      providerId,
      isActive: isActive ?? true,
      // 对外展示默认开：新建模型多半是要给用户用的。
      // 只有明确传 false 才隐藏，避免「新建后前端看不到」这类困惑。
      isPublic: isPublic ?? true,
      supportsVision: supportsVision ?? false,
      // NaN 不能入库：contextWindow 参与历史预算，NaN 会绕过 `> 0` 判断、链最小窗口比较也失效
      contextWindow: contextWindow == null || contextWindow === ''
        ? null
        : (() => {
            const n = toFiniteNumber(contextWindow, NaN)
            if (!Number.isFinite(n) || n <= 0) throw new Error('上下文窗口必须是正数')
            return Math.round(n)
          })(),
      metadata: metadataSanitized || null,
    },
  })

  return serializeModel(model)
})
