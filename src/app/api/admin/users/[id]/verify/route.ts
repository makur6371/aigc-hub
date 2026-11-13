import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { creditPoints } from '@/lib/billing/wallet'
import { hasRegistrationBonus } from '@/lib/billing/registration-bonus'
import { SECURITY_VERIFY_BONUS_POINTS } from '@/lib/billing/welcome'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { writeAdminAction } from '@/lib/admin-audit'

/** 管理员人工核验通过:securityLevel=HIGH, adminVerified=true */
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const user = await prisma.user.findUnique({ where: { id } })
    if (!user) {
      throw new ApiHandlerError('用户不存在', 404)
    }
    if (user.securityLevel === 'HIGH' && user.adminVerified) {
      throw new ApiHandlerError('该用户已通过核验', 400)
    }
    if (!user.nickname?.trim()) {
      throw new ApiHandlerError('请先让用户设置昵称（建议与微信昵称一致）', 400)
    }

    let grantedSecurityReward = false
    let registrationBonusAlreadyGranted = false

    const updated = await prisma.$transaction(async (tx) => {
      // 原子认领：仅 adminVerified=false 可核验，并发双击时第二个事务失败，杜绝奖励双发
      const claimed = await tx.user.updateMany({
        where: { id, adminVerified: false },
        data: {
          securityLevel: 'HIGH',
          adminVerified: true,
        },
      })
      if (claimed.count === 0) {
        throw new ApiHandlerError('该用户已通过核验', 400)
      }
      // 与自助安全验证共用同一个一次性凭证：谁先完成谁发 20 分，另一条路径不再重复发。
      const securityClaim = await tx.user.updateMany({
        where: { id, securityVerifiedAt: null },
        data: { securityVerifiedAt: new Date(), securityLevel: 'HIGH' },
      })
      if (securityClaim.count > 0) {
        registrationBonusAlreadyGranted = await hasRegistrationBonus(tx, id)
        grantedSecurityReward = !registrationBonusAlreadyGranted
      }
      if (grantedSecurityReward) {
        await creditPoints({
          userId: id,
          amount: SECURITY_VERIFY_BONUS_POINTS,
          description: '安全验证奖励（人工核验）',
          type: 'BONUS',
          tx,
        })
      }
      const u = await tx.user.findUnique({
        where: { id },
        select: { id: true, phone: true, securityLevel: true, adminVerified: true, securityVerifiedAt: true },
      })
      await writeAdminAction(tx, {
        adminId: authUser.userId,
        userId: id,
        action: 'manual_verify',
        // 原先这条留痕没有 note，事后只看得到一个 action，
        // 分不清「有没有连带发奖励」—— 核验奖励是真金白银，必须可读。
        note: `管理员人工核验账号${grantedSecurityReward ? '，并发放 20 积分安全验证奖励' : registrationBonusAlreadyGranted ? '，20 积分已在注册时发放，不重复发' : '（已通过安全验证，未重复发奖励）'}`,
      })
      return u
    })

    return success(
      updated,
      grantedSecurityReward ? '核验通过，已赠送 20 积分，已解锁全部功能' : registrationBonusAlreadyGranted ? '核验通过，20 积分已在注册时发放，已解锁全部功能' : '核验通过，已解锁全部功能'
    )
  }
)
