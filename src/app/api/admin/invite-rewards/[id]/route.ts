import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { creditPoints, adjustPoints } from '@/lib/billing/wallet'
import { computeUsagePercent } from '@/lib/invite/settle'
import { resolveAvailableBalance } from '@/lib/billing/team'
import { writeAdminAction } from '@/lib/admin-audit'

// PATCH /api/admin/invite-rewards/[id] - 人工处理返利：发放 / 取消 / 扣回
export const PATCH = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params
    const body = await request.json() as { action?: string }
    const action = body.action
    if (action !== 'pay' && action !== 'cancel' && action !== 'clawback') {
      throw new ApiHandlerError('无效操作', 400)
    }

    const prisma = await getPrisma()
    const reward = await prisma.inviteReward.findUnique({ where: { id } })
    if (!reward) throw new ApiHandlerError('返利记录不存在', 404)

    if (action === 'pay') {
      if (reward.status !== 'PENDING') throw new ApiHandlerError('仅待发放状态可发放', 400)
      const usagePercent = await computeUsagePercent(reward.inviteeId).catch(() => reward.usagePercent)
      // 认领、到账、留痕同一事务（Q-D42）：此前是先 updateMany 置 PAID、再 creditPoints 发钱。
      // 中间失败就留下「返利已标记为已发放，但积分没到账」的哑账 —— 状态看着结了，钱没动，
      // 而 `claimed.count` 的幂等闸门已经把重试路径关掉了，谁也修不了它。
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.inviteReward.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'PAID', usagePercent, paidAt: new Date() },
        })
        if (claimed.count === 0) throw new ApiHandlerError('该返利已被处理', 409)
        await creditPoints({
          userId: reward.inviterId,
          amount: reward.rewardPoints,
          type: 'BONUS',
          description: '邀请返利：管理员人工发放',
          tx,
        })
        await writeAdminAction(tx, {
          adminId: admin.userId,
          userId: reward.inviterId,
          action: 'invite_reward_pay',
          note: `管理员人工发放邀请返利 ${reward.rewardPoints} 积分（被邀请人 ${reward.inviteeId}，用量 ${usagePercent}%）`,
        })
      })
      return success({ id, status: 'PAID' }, '已发放')
    }

    if (action === 'cancel') {
      if (reward.status !== 'PENDING') throw new ApiHandlerError('仅待发放状态可取消', 400)
      await prisma.$transaction(async (tx) => {
        await tx.inviteReward.update({ where: { id }, data: { status: 'CANCELED' } })
        await writeAdminAction(tx, {
          adminId: admin.userId,
          userId: reward.inviterId,
          action: 'invite_reward_cancel',
          note: `管理员取消了一笔待发放的邀请返利 ${reward.rewardPoints} 积分（被邀请人 ${reward.inviteeId}）`,
        })
      })
      return success({ id, status: 'CANCELED' }, '已取消')
    }

    // clawback：仅对已发放的返利扣回，积分不足时拒绝，避免扣成负数
    if (reward.status !== 'PAID') throw new ApiHandlerError('仅已发放状态可扣回', 400)
    const inviter = await prisma.user.findUnique({ where: { id: reward.inviterId }, select: { points: true } })
    if (!inviter) throw new ApiHandlerError('邀请人不存在', 404)
    // 扣回也认归属：返利当初若是发进团队池，就从团队池扣回（否则会把成员的余额扣成负数）
    const ownerBal = await resolveAvailableBalance(reward.inviterId)
    if (ownerBal.points < reward.rewardPoints) {
      throw new ApiHandlerError('邀请人积分不足，无法扣回', 400)
    }
    const clawbackFrom = ownerBal.ownerId
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.inviteReward.updateMany({
        where: { id, status: 'PAID' },
        data: { status: 'CLAWBACK' },
      })
      if (claimed.count === 0) throw new ApiHandlerError('该返利已被处理', 409)
      // 扣减必须走 wallet 的条件 UPDATE（余额不足时命中 0 行并抛错）。
      // 原先这里是「先查余额 → 再裸 UPDATE」，两步之间任何并发扣费都能把余额扣穿成负数，
      // 而负余额在 SQLite 下没有任何东西会报错 —— 只能事后对账才发现。
      await adjustPoints(reward.inviterId, -reward.rewardPoints, '邀请返利：管理员扣回', tx, {
        type: 'ADMIN_ADJUST',
        billingOwnerId: ownerBal.isTeam ? clawbackFrom : null,
      })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: reward.inviterId,
        action: 'invite_reward_clawback',
        note: `管理员扣回已发放的邀请返利 ${reward.rewardPoints} 积分${ownerBal.isTeam ? '（从团队共享池扣回）' : ''}`,
      })
    })
    return success({ id, status: 'CLAWBACK' }, '已扣回')
  }
)
