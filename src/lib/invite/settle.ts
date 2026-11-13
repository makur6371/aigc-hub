import { getPrisma } from '@/lib/prisma'
import { creditPoints } from '@/lib/billing/wallet'
import { getInvitePolicy } from './policy'

/** 被邀请人累计已购买（积分 + 豆） */
async function purchasedPoints(prisma: Awaited<ReturnType<typeof getPrisma>>, userId: string): Promise<number> {
  const agg = await prisma.rechargeOrder.aggregate({
    where: { userId, status: 'PAID' },
    _sum: { points: true, beans: true },
  })
  return Math.max(0, agg._sum.points ?? 0) + Math.max(0, agg._sum.beans ?? 0)
}

/** 被邀请人累计已消耗（积分 + 豆，仅真实扣款，排除画布内部记账） */
async function consumedPoints(prisma: Awaited<ReturnType<typeof getPrisma>>, userId: string): Promise<number> {
  const [pointsAgg, beansAgg] = await Promise.all([
    prisma.pointsLog.aggregate({
      where: { userId, type: 'DEDUCTION', category: null },
      _sum: { amount: true },
    }),
    prisma.beansLog.aggregate({
      where: { userId, type: 'DEDUCTION', category: null },
      _sum: { amount: true },
    }),
  ])
  return Math.abs(pointsAgg._sum.amount ?? 0) + Math.abs(beansAgg._sum.amount ?? 0)
}

/** 计算被邀请人当前使用比例（0-100，未购买返回 0） */
export async function computeUsagePercent(inviteeId: string): Promise<number> {
  const prisma = await getPrisma()
  const [purchased, consumed] = await Promise.all([
    purchasedPoints(prisma, inviteeId),
    consumedPoints(prisma, inviteeId),
  ])
  if (purchased <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((consumed / purchased) * 100)))
}

/**
 * 结算某被邀请人的待发放返利：达到使用比例门槛则把返利积分发给邀请人。
 * 原子认领 PENDING→PAID，并发/重复调用不会重复发放。返回本次发放笔数。
 */
export async function settleInviteRewards(inviteeId: string): Promise<number> {
  const prisma = await getPrisma()
  const pending = await prisma.inviteReward.findMany({
    where: { inviteeId, status: 'PENDING' },
    select: { id: true, inviterId: true, rewardPoints: true, requiredUsagePercent: true },
  })
  if (pending.length === 0) return 0

  const [purchased, consumed] = await Promise.all([
    purchasedPoints(prisma, inviteeId),
    consumedPoints(prisma, inviteeId),
  ])
  if (purchased <= 0) return 0

  const rawUsage = Math.floor((consumed / purchased) * 100)
  const usagePercent = Math.max(0, Math.min(100, rawUsage))
  const fallbackThreshold = (await getInvitePolicy()).requiredUsagePercent
  let paidCount = 0

  for (const reward of pending) {
    const threshold = reward.requiredUsagePercent || fallbackThreshold
    if (rawUsage < threshold) {
      if (usagePercent > 0) {
        await prisma.inviteReward.update({ where: { id: reward.id }, data: { usagePercent } })
      }
      continue
    }
    // 认领 + 发积分同一事务：避免"标记已发放但积分没到账"的中间态
    const paid = await prisma.$transaction(async (tx) => {
      const claimed = await tx.inviteReward.updateMany({
        where: { id: reward.id, status: 'PENDING' },
        data: { status: 'PAID', usagePercent, paidAt: new Date() },
      })
      if (claimed.count === 0) return false
      await creditPoints({
        userId: reward.inviterId,
        amount: reward.rewardPoints,
        type: 'BONUS',
        description: '邀请返利：好友使用达标',
        tx,
      })
      return true
    })
    if (paid) paidCount++
  }
  return paidCount
}

/** 结算某邀请人名下所有被邀请人的待发放返利（邀请人查看邀请页时触发） */
export async function settleInviteRewardsForInviter(inviterId: string): Promise<void> {
  const prisma = await getPrisma()
  const invitees = await prisma.inviteReward.findMany({
    where: { inviterId, status: 'PENDING' },
    select: { inviteeId: true },
    distinct: ['inviteeId'],
  })
  for (const { inviteeId } of invitees) {
    await settleInviteRewards(inviteeId).catch(() => {})
  }
}
