import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'

/**
 * 后台：企业团队审核列表。
 *
 * 团队 = 让一个账号为其他账号付费（资金权力），必须由平台管理员审核后才生效。
 * 生效闸门在 lib/billing/team.ts 的 resolveBillingOwner（扣费路径），
 * 本接口只负责「看 + 批」。
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50 })
  const status = url.searchParams.get('status') || undefined

  const where: Prisma.TeamWhereInput = {}
  if (status && status !== 'all') where.status = status

  const [items, total] = await Promise.all([
    prisma.team.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        owner: { select: { id: true, nickname: true, phone: true, email: true, points: true, beans: true, createdAt: true } },
      },
    }),
    prisma.team.count({ where }),
  ])

  // 全站团队总览：管理员最关心的三个数 —— 有多少家、覆盖多少成员、共享池消耗多大。
  // 放在同一个接口里返回，避免前端为首屏再打一次请求。
  const [pendingCount, approvedCount, memberTotal, sharedSpend] = await Promise.all([
    prisma.team.count({ where: { status: 'PENDING' } }),
    prisma.team.count({ where: { status: 'APPROVED' } }),
    prisma.user.count({ where: { billingOwnerId: { not: null } } }),
    // 共享池消耗（净额口径见 lib 注释）：团队出资的扣费合计
    prisma.pointsLog.aggregate({ where: { billingOwnerId: { not: null }, type: 'DEDUCTION' }, _sum: { amount: true } }),
  ])
  const summary = {
    pendingCount,
    approvedCount,
    suspendedCount: await prisma.team.count({ where: { status: 'SUSPENDED' } }),
    memberTotal,
    sharedSpentPoints: Math.abs(sharedSpend._sum.amount ?? 0),
  }

  // 成员数与今日消费：审核时最需要判断「这个团队是不是真实企业」
  const teamIds = items.map((t) => t.ownerId)
  const [memberCounts, spends] = await Promise.all([
    prisma.user.groupBy({ by: ['billingOwnerId'], where: { billingOwnerId: { in: teamIds } }, _count: true }),
    prisma.pointsLog.groupBy({
      by: ['billingOwnerId'],
      where: { billingOwnerId: { in: teamIds }, type: 'DEDUCTION' },
      _sum: { amount: true },
    }),
  ])
  const memberMap = new Map(memberCounts.map((r) => [r.billingOwnerId, r._count]))
  const spendMap = new Map(spends.map((r) => [r.billingOwnerId, Math.abs(r._sum.amount ?? 0)]))

  return {
    summary,
    items: items.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      reviewNote: t.reviewNote,
      reviewedAt: t.reviewedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      defaultDailyLimit: t.defaultDailyLimit,
      defaultDailyBeans: t.defaultDailyBeans,
      owner: {
        id: t.owner.id,
        name: t.owner.nickname || t.owner.phone || t.owner.email || t.owner.id,
        phone: t.owner.phone,
        email: t.owner.email,
        points: t.owner.points,
        beans: t.owner.beans,
        registeredAt: t.owner.createdAt.toISOString(),
      },
      memberCount: memberMap.get(t.ownerId) ?? 0,
      totalSpentPoints: spendMap.get(t.ownerId) ?? 0,
    })),
    total,
    page,
    pageSize,
  }
})
