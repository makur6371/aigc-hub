import { getPrisma } from '@/lib/prisma'

/**
 * 团队消费明细聚合（老板视角）。
 *
 * 抽成 lib 而不是写在 route 里，是为了能对**真实函数**跑真库断言 ——
 * 这是动钱功能的规矩：查询口径必须被锁住，不能让 route 里的
 * groupBy 变成一份「没测过的副本」。
 *
 * 口径（必须与扣费侧、个人账本一致）：
 *   - billingOwnerId = 老板（我出的钱）
 *   - category = null（只算真实动过余额的流水，排除画布节点内部分摊）
 *   - 净额 = SUM(amount)，扣费为负、退款为正；取负给前端显示「花了多少」
 *   - 调用次数只数 DEDUCTION（退款不计，否则失败重试会虚高）
 *   - 豆与积分是两种币种，各自聚合，绝不相加
 */

export interface TeamMemberRollup {
  memberId: string
  name: string
  teamSpentPoints: number
  teamSpentBeans: number
  callCount: number
  lastAt: string | null
}

export interface TeamSpendItem {
  id: string
  kind: 'points' | 'beans'
  amount: number
  type: string
  description: string | null
  createdAt: string
  memberId: string
  memberName: string
  runId: string | null
}

export interface TeamSpending {
  summary: { spentPoints: number; spentBeans: number; callCount: number; memberCount: number }
  members: TeamMemberRollup[]
  items: TeamSpendItem[]
  total: number
}

export async function getTeamSpending(
  ownerId: string,
  opts: { memberId?: string | null; page?: number; pageSize?: number } = {},
): Promise<TeamSpending> {
  const prisma = await getPrisma()
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 20))
  const memberId = opts.memberId?.trim() || null

  const members = await prisma.user.findMany({
    where: { billingOwnerId: ownerId },
    select: { id: true, nickname: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const nameOf = new Map(members.map((m) => [m.id, m.nickname || m.phone || '成员']))

  const [pointRoll, beanRoll, pointCalls] = await Promise.all([
    prisma.pointsLog.groupBy({
      by: ['userId'],
      where: { billingOwnerId: ownerId, category: null },
      _sum: { amount: true },
      _max: { createdAt: true },
    }),
    prisma.beansLog.groupBy({
      by: ['userId'],
      where: { billingOwnerId: ownerId, category: null },
      _sum: { amount: true },
      _max: { createdAt: true },
    }),
    // 只数扣费：把退款也数进去会让「一次失败重试」看起来像两次调用
    prisma.pointsLog.groupBy({
      by: ['userId'],
      where: { billingOwnerId: ownerId, category: null, type: 'DEDUCTION' },
      _count: { _all: true },
    }),
  ])
  const pointMap = new Map(pointRoll.map((r) => [r.userId, r]))
  const beanMap = new Map(beanRoll.map((b) => [b.userId, b]))
  const callMap = new Map(pointCalls.map((c) => [c.userId, c._count._all]))

  const rollup: TeamMemberRollup[] = members.map((m) => {
    const p = pointMap.get(m.id)
    const b = beanMap.get(m.id)
    const lastCandidates = [p?._max.createdAt, b?._max.createdAt].filter((d): d is Date => !!d)
    return {
      memberId: m.id,
      name: nameOf.get(m.id) || '成员',
      teamSpentPoints: -(p?._sum.amount ?? 0),
      teamSpentBeans: -(b?._sum.amount ?? 0),
      callCount: callMap.get(m.id) ?? 0,
      lastAt: lastCandidates.length
        ? new Date(Math.max(...lastCandidates.map((d) => d.getTime()))).toISOString()
        : null,
    }
  })
  rollup.sort((a, b) => b.teamSpentPoints - a.teamSpentPoints)

  const detailWhere = { billingOwnerId: ownerId, category: null, ...(memberId ? { userId: memberId } : {}) }
  const [pointItems, beanItems, pointCount, beanCount, teamPointTotal, teamBeanTotal, teamCallCount] = await Promise.all([
    prisma.pointsLog.findMany({
      where: detailWhere, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      include: { user: { select: { id: true, nickname: true, phone: true } } },
    }),
    prisma.beansLog.findMany({
      where: detailWhere, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      include: { user: { select: { id: true, nickname: true, phone: true } } },
    }),
    prisma.pointsLog.count({ where: detailWhere }),
    prisma.beansLog.count({ where: detailWhere }),
    prisma.pointsLog.aggregate({ where: { billingOwnerId: ownerId, category: null }, _sum: { amount: true } }),
    prisma.beansLog.aggregate({ where: { billingOwnerId: ownerId, category: null }, _sum: { amount: true } }),
    prisma.pointsLog.count({ where: { billingOwnerId: ownerId, category: null, type: 'DEDUCTION' } }),
  ])

  const items: TeamSpendItem[] = [
    ...pointItems.map((l) => ({
      id: `p_${l.id}`, kind: 'points' as const, amount: l.amount, type: l.type,
      description: l.description, createdAt: l.createdAt.toISOString(),
      memberId: l.userId, memberName: l.user.nickname || l.user.phone || '成员', runId: l.runId ?? null,
    })),
    ...beanItems.map((l) => ({
      id: `b_${l.id}`, kind: 'beans' as const, amount: l.amount, type: l.type,
      description: l.description, createdAt: l.createdAt.toISOString(),
      memberId: l.userId, memberName: l.user.nickname || l.user.phone || '成员', runId: l.runId ?? null,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  return {
    summary: {
      spentPoints: -(teamPointTotal._sum.amount ?? 0),
      spentBeans: -(teamBeanTotal._sum.amount ?? 0),
      callCount: teamCallCount,
      memberCount: members.length,
    },
    members: rollup,
    items,
    total: pointCount + beanCount,
  }
}
