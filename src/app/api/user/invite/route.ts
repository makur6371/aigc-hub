import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { settleInviteRewardsForInviter, computeUsagePercent } from '@/lib/invite/settle'
import { getInvitePolicy } from '@/lib/invite/policy'

/**
 * 获取当前用户的邀请信息：
 * - 我的邀请码（userId 即邀请码）
 * - 我邀请的人数
 * - 累计返利积分
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  // 惰性结算：进入邀请页时把已达标的待发放返利结掉（零运维，无需定时任务）
  await settleInviteRewardsForInviter(authUser.userId).catch((e) => console.error('邀请返利结算失败:', e))

  const policy = await getInvitePolicy()

  const [relations, rewards] = await Promise.all([
    prisma.inviteRelation.findMany({
      where: { inviterId: authUser.userId },
      include: {
        invitee: { select: { id: true, phone: true, nickname: true, createdAt: true } },
        rewards: {
          select: {
            status: true, rewardPoints: true, usagePercent: true,
            requiredUsagePercent: true, paidAmountCents: true, paidAt: true, createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.inviteReward.aggregate({
      where: { inviterId: authUser.userId, status: 'PAID' },
      _sum: { rewardPoints: true },
    }),
  ])

  const pendingSum = await prisma.inviteReward.aggregate({
    where: { inviterId: authUser.userId, status: 'PENDING' },
    _sum: { rewardPoints: true },
  })

  // 每个被邀请人的实时使用比例（用于进度展示）
  const usageByInvitee = new Map<string, number>()
  await Promise.all(
    relations.map(async (r) => {
      usageByInvitee.set(r.invitee.id, await computeUsagePercent(r.invitee.id).catch(() => 0))
    })
  )

  return {
    inviteCode: authUser.userId,
    invitedCount: relations.length,
    totalRewardPoints: rewards._sum.rewardPoints ?? 0,
    pendingRewardPoints: pendingSum._sum.rewardPoints ?? 0,
    policy: {
      rewardPercent: policy.rewardPercent,
      requiredUsagePercent: policy.requiredUsagePercent,
      minPaidCents: policy.minPaidCents,
      enabled: policy.enabled,
    },
    invitedUsers: relations.map((r) => ({
      id: r.id,
      phone: r.invitee.phone,
      nickname: r.invitee.nickname,
      createdAt: r.createdAt.toISOString(),
      usagePercent: usageByInvitee.get(r.invitee.id) ?? 0,
      rewards: r.rewards.map((rw) => ({
        status: rw.status,
        rewardPoints: rw.rewardPoints,
        usagePercent: rw.usagePercent,
        requiredUsagePercent: rw.requiredUsagePercent,
        paidAmountCents: rw.paidAmountCents,
        paidAt: rw.paidAt?.toISOString() ?? null,
        createdAt: rw.createdAt.toISOString(),
      })),
    })),
  }
})
