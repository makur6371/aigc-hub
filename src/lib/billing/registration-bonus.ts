import type { Prisma } from '@prisma/client'
import { REGISTRATION_BONUS_DESCRIPTION } from './welcome'

type PointsLogLookup = Pick<Prisma.TransactionClient, 'pointsLog'>

/** 历史账号是否已领取过注册奖励（用于避免安全验证再发第二笔 20 分）。 */
export async function hasRegistrationBonus(db: PointsLogLookup, userId: string): Promise<boolean> {
  const row = await db.pointsLog.findFirst({
    where: { userId, type: 'BONUS', description: REGISTRATION_BONUS_DESCRIPTION },
    select: { id: true },
  })
  return row !== null
}
