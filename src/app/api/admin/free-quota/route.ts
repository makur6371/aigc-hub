import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { localDayKey } from '@/lib/free-quota'

// 每日免费额度池：集中查看/配置所有模型的免费额度，并显示今日已用/剩余。
// 额度语义见 src/lib/free-quota.ts：每用户额度 + 平台总额度两级同时生效，每日 0 点自然重置。

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()

  const models = await prisma.modelConfig.findMany({
    where: { isActive: true },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    include: { provider: { select: { name: true, code: true } } },
  })

  const day = localDayKey()
  // 今日各模型平台侧用量（一次聚合，避免逐模型查询）
  const usage = await prisma.modelFreeQuotaUsage.groupBy({
    by: ['modelId'],
    where: { day },
    _sum: { count: true },
  })
  const platformUsedByModel = new Map(usage.map((u) => [u.modelId, u._sum.count ?? 0]))

  const items = models.map((m) => {
    const userLimit = Math.max(0, m.dailyUserFreeQuota ?? 0)
    const platformLimit = Math.max(0, m.dailyPlatformFreeQuota ?? 0)
    const platformUsed = platformUsedByModel.get(m.id) ?? 0
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      provider: m.provider?.name ?? '',
      isFree: m.isFree,
      costPoints: m.costPoints,
      dailyUserFreeQuota: m.dailyUserFreeQuota,
      dailyPlatformFreeQuota: m.dailyPlatformFreeQuota,
      // 今日平台侧已用/剩余（未配平台上限则剩余为 null）
      platformUsedToday: platformUsed,
      platformRemainingToday: platformLimit > 0 ? Math.max(0, platformLimit - platformUsed) : null,
      enabled: userLimit > 0,
    }
  })

  return { day, items }
})

// 批量设置某个模型的免费额度（0/空 = 关闭）
export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json() as {
    id?: string
    dailyUserFreeQuota?: number | string | null
    dailyPlatformFreeQuota?: number | string | null
  }
  if (!body.id) throw new ApiHandlerError('缺少模型 id', 400)

  const toQuota = (v: number | string | null | undefined): number | null => {
    if (v == null || v === '') return null
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < 0) throw new ApiHandlerError('额度需为非负整数', 400)
    return n === 0 ? null : n
  }

  const prisma = await getPrisma()
  const model = await prisma.modelConfig.update({
    where: { id: body.id },
    data: {
      dailyUserFreeQuota: toQuota(body.dailyUserFreeQuota),
      dailyPlatformFreeQuota: toQuota(body.dailyPlatformFreeQuota),
    },
    select: { id: true, name: true, dailyUserFreeQuota: true, dailyPlatformFreeQuota: true },
  })
  return success(model, '已保存')
})

// 清零今日用量（调试/紧急重置用）
export const DELETE = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const url = new URL(request.url)
  const modelId = url.searchParams.get('modelId')
  const prisma = await getPrisma()
  const res = await prisma.modelFreeQuotaUsage.deleteMany({
    where: { day: localDayKey(), ...(modelId ? { modelId } : {}) },
  })
  return success({ cleared: res.count }, `已清零今日用量（${res.count} 条）`)
})
