import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'

// GET /api/admin/invite-rewards - 返利流水（支持状态筛选）
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { pageSize: 20, maxPageSize: 100 })
  const status = url.searchParams.get('status')
  const where = status && status !== 'all' ? { status } : {}

  const [items, total] = await Promise.all([
    prisma.inviteReward.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inviteReward.count({ where }),
  ])

  const userIds = [...new Set(items.flatMap((r) => [r.inviterId, r.inviteeId]))]
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, nickname: true, phone: true },
  })
  const nameOf = new Map(users.map((u) => [u.id, u.nickname || u.phone || '未知']))

  return {
    items: items.map((r) => ({
      id: r.id,
      inviterName: nameOf.get(r.inviterId) ?? '未知',
      inviteeName: nameOf.get(r.inviteeId) ?? '未知',
      paidAmountCents: r.paidAmountCents,
      rewardPoints: r.rewardPoints,
      usagePercent: r.usagePercent,
      requiredUsagePercent: r.requiredUsagePercent,
      status: r.status,
      paidAt: r.paidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  }
})
