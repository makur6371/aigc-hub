import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { localDayKey } from '@/lib/day-key'

// 单个用户的领取日志：每一笔时长券「从哪来、多少天、什么时候生效/到期、谁代发」。
// 与 /api/admin/free-image-pass 的全局最近发放互补：那边看平台，这里看一个人。

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const url = new URL(request.url)
  const userId = (url.searchParams.get('userId') ?? '').trim()
  if (!userId) throw new ApiHandlerError('缺少 userId', 400)
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? 1)) || 1)
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize') ?? 20)) || 20))

  const prisma = await getPrisma()
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, phone: true, freeImageUntil: true, createdAt: true },
  })
  if (!user) throw new ApiHandlerError('用户不存在', 404)

  const now = new Date()
  const day = localDayKey(now)
  const usageSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [total, grants, grantedAgg, usageAgg, usageToday, lastUsage] = await Promise.all([
    prisma.freeImageGrant.count({ where: { userId } }),
    prisma.freeImageGrant.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.freeImageGrant.aggregate({ where: { userId }, _sum: { minutes: true } }),
    prisma.freeImagePassUsage.count({ where: { userId, createdAt: { gte: usageSince } } }),
    prisma.freeImagePassUsage.count({ where: { userId, day } }),
    prisma.freeImagePassUsage.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    }),
  ])

  // 管理员代发的操作人：单独查一次，避免给 grants 加关系拖慢主表
  const operatorIds = [...new Set(grants.map((g) => g.operatorId).filter((id): id is string => !!id))]
  const operators = operatorIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: operatorIds } },
        select: { id: true, nickname: true, phone: true },
      })
  const operatorById = new Map(operators.map((o) => [o.id, o.nickname || o.phone || o.id.slice(0, 8)]))

  const remainingMinutes = user.freeImageUntil && user.freeImageUntil > now
    ? Math.round((user.freeImageUntil.getTime() - now.getTime()) / 60000)
    : 0

  return success({
    user: {
      id: user.id,
      nickname: user.nickname,
      phone: user.phone,
      freeImageUntil: user.freeImageUntil?.toISOString() ?? null,
      remainingMinutes,
      createdAt: user.createdAt.toISOString(),
    },
    summary: {
      totalGrants: total,
      totalGrantedDays: Math.round(((grantedAgg._sum.minutes ?? 0) / (24 * 60)) * 10) / 10,
      usage30d: usageAgg,
      usageToday,
      lastUsedAt: lastUsage?.createdAt.toISOString() ?? null,
    },
    grants: grants.map((g) => ({
      id: g.id,
      source: g.source,
      description: g.description,
      minutes: g.minutes,
      startsAt: g.startsAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      createdAt: g.createdAt.toISOString(),
      operatorId: g.operatorId,
      operatorName: g.operatorId ? operatorById.get(g.operatorId) ?? g.operatorId.slice(0, 8) : null,
    })),
    pagination: { page, pageSize, total },
  })
})
