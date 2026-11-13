import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { localDayKey } from '@/lib/day-key'
import { clearFreeImagePassPolicyCache, getFreeImagePassPolicy, isPassModelCovered } from '@/lib/promotions/free-image-pass'
import { recordAdminAction } from '@/lib/admin-audit'

// 生图时长券：策略配置 + 覆盖模型 + 发放/使用统计 + 用户剩余时长。
//
// 与「免费额度池」的分工：
//   - 免费额度池 = 没有时长券时，每天最多免费几次（按次数，用 ModelFreeQuotaUsage）
//   - 时长券     = 有效期内免费，但可以单独限「每天最多几张」（用 FreeImagePassUsage）
// 两者互斥：时长券命中时不占每日额度，额度命中时也不写券台账。

function toLimit(v: unknown, label: string): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    throw new ApiHandlerError(`${label}需为 0~1000000 的整数（0 = 不限）`, 400)
  }
  return n
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const status = url.searchParams.get('status') === 'expired' ? 'expired' : 'active'
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? 1)) || 1)
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize') ?? 20)) || 20))

  const now = new Date()
  const day = localDayKey(now)
  const dayStart = startOfLocalDay(now)
  const usageSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const userWhere = {
    ...(status === 'active'
      ? { freeImageUntil: { gt: now } }
      : { freeImageUntil: { lte: now } }),
    ...(q
      ? { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] }
      : {}),
  }

  const [policy, coveredModels, activeUsers, todayGrants, todayGrantAgg, todayUsage, todayUsageUsers, recentGrants, userTotal, userRows] = await Promise.all([
    getFreeImagePassPolicy(),
    prisma.modelConfig.findMany({
      where: { type: 'IMAGE', isActive: true },
      orderBy: [{ dailyUserFreeQuota: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, dailyUserFreeQuota: true, dailyPlatformFreeQuota: true, provider: { select: { name: true } } },
    }),
    prisma.user.count({ where: { freeImageUntil: { gt: now } } }),
    prisma.freeImageGrant.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.freeImageGrant.aggregate({ where: { createdAt: { gte: dayStart } }, _sum: { minutes: true } }),
    prisma.freeImagePassUsage.count({ where: { day } }),
    prisma.freeImagePassUsage.groupBy({ by: ['userId'], where: { day } }),
    prisma.freeImageGrant.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, minutes: true, source: true, description: true, startsAt: true, expiresAt: true, createdAt: true, operatorId: true,
        user: { select: { id: true, nickname: true, phone: true } },
      },
    }),
    prisma.user.count({ where: userWhere }),
    prisma.user.findMany({
      where: userWhere,
      // 唯一键做 tiebreaker：同一秒到期的多个用户翻页才不会漏行/重行
      orderBy: status === 'active' ? [{ freeImageUntil: 'asc' }, { id: 'asc' }] : [{ freeImageUntil: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, nickname: true, phone: true, freeImageUntil: true },
    }),
  ])

  const userIds = userRows.map((u) => u.id)
  const usageAgg = userIds.length === 0 ? [] : await prisma.freeImagePassUsage.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, createdAt: { gte: usageSince } },
    _count: { _all: true },
    _max: { createdAt: true },
  })
  const usageTodayAgg = userIds.length === 0 ? [] : await prisma.freeImagePassUsage.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, day },
    _count: { _all: true },
  })
  const grantAgg = userIds.length === 0 ? [] : await prisma.freeImageGrant.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _sum: { minutes: true },
  })

  const usageByUser = new Map(usageAgg.map((r) => [r.userId, r]))
  const usageTodayByUser = new Map(usageTodayAgg.map((r) => [r.userId, r._count._all]))
  const grantedByUser = new Map(grantAgg.map((r) => [r.userId, r._sum.minutes ?? 0]))

  // 管理员代发的操作人：只在最近发放列表里补名字，避免干扰主查询
  const grantOperatorIds = [...new Set(recentGrants.map((g) => g.operatorId).filter((id): id is string => !!id))]
  const grantOperators = grantOperatorIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: grantOperatorIds } },
        select: { id: true, nickname: true, phone: true },
      })
  const grantOperatorById = new Map(grantOperators.map((o) => [o.id, o.nickname || o.phone || o.id.slice(0, 8)]))

  return success({
    policy,
    coveredModels: coveredModels.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider?.name ?? '',
      dailyUserFreeQuota: m.dailyUserFreeQuota,
      dailyPlatformFreeQuota: m.dailyPlatformFreeQuota,
      covered: isPassModelCovered({ ...m, type: 'IMAGE' }, policy),
    })),
    stats: {
      activeUsers,
      todayGrants,
      todayGrantedDays: Math.round(((todayGrantAgg._sum.minutes ?? 0) / (24 * 60)) * 10) / 10,
      todayUsage,
      todayUsageUsers: todayUsageUsers.length,
    },
    recentGrants: recentGrants.map((g) => ({
      ...g,
      operatorName: g.operatorId ? grantOperatorById.get(g.operatorId) ?? g.operatorId.slice(0, 8) : null,
      startsAt: g.startsAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      createdAt: g.createdAt.toISOString(),
    })),
    users: {
      total: userTotal,
      page,
      pageSize,
      items: userRows.map((u) => {
        const usage = usageByUser.get(u.id)
        const remainingMinutes = u.freeImageUntil && u.freeImageUntil > now
          ? Math.round((u.freeImageUntil.getTime() - now.getTime()) / 60000)
          : 0
        return {
          id: u.id,
          nickname: u.nickname,
          phone: u.phone,
          freeImageUntil: u.freeImageUntil?.toISOString() ?? null,
          remainingMinutes,
          totalGrantedDays: Math.round(((grantedByUser.get(u.id) ?? 0) / (24 * 60)) * 10) / 10,
          usage30d: usage?._count._all ?? 0,
          usageToday: usageTodayByUser.get(u.id) ?? 0,
          lastUsedAt: usage?._max.createdAt?.toISOString() ?? null,
        }
      }),
    },
    day,
  })
})

export const PUT = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth(request, { admin: true })
  const body = await request.json() as {
    enabled?: boolean
    dailyUserLimit?: number | string
    dailyPlatformLimit?: number | string
    modelIds?: unknown
  }
  const enabled = body.enabled !== false
  const dailyUserLimit = toLimit(body.dailyUserLimit ?? 0, '每用户每日上限')
  const dailyPlatformLimit = toLimit(body.dailyPlatformLimit ?? 0, '全平台每日上限')

  const prisma = await getPrisma()
  if (body.modelIds !== undefined && body.modelIds !== null && (!Array.isArray(body.modelIds) || body.modelIds.some((id) => typeof id !== 'string'))) {
    throw new ApiHandlerError('覆盖模型需为模型 ID 列表', 400)
  }
  const modelIds = Array.isArray(body.modelIds) ? [...new Set(body.modelIds as string[])] : body.modelIds
  if (Array.isArray(modelIds)) {
    const count = await prisma.modelConfig.count({ where: { id: { in: modelIds }, type: 'IMAGE', isActive: true } })
    if (count !== modelIds.length) throw new ApiHandlerError('部分模型已停用或不属于图片模型，请刷新后重选', 400)
  }
  const coverage = modelIds === undefined ? {} : { modelIds: modelIds === null ? Prisma.DbNull : modelIds }
  const policy = await prisma.freeImagePassPolicy.upsert({
    where: { id: 'primary' },
    update: { enabled, dailyUserLimit, dailyPlatformLimit, ...coverage },
    create: { id: 'primary', enabled, dailyUserLimit, dailyPlatformLimit, ...coverage },
  })
  clearFreeImagePassPolicyCache()
  await recordAdminAction({
    adminId: auth.userId,
    userId: auth.userId,
    action: 'free_image_pass_policy',
    note: `时长券：${enabled ? '启用' : '停用'}，每用户每天 ${dailyUserLimit || '不限'} 张，全平台每天 ${dailyPlatformLimit || '不限'} 张，覆盖模型 ${JSON.stringify(policy.modelIds)}`,
  })
  return success({
    enabled: policy.enabled,
    dailyUserLimit: policy.dailyUserLimit,
    dailyPlatformLimit: policy.dailyPlatformLimit,
    modelIds: policy.modelIds,
  }, '已保存')
})
