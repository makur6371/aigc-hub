import { getPrisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

/**
 * 解析一份问卷的目标用户集合。
 *   ALL  → 所有 NORMAL 用户
 *   TEAM → 企业 owner + billingOwnerId=owner 的成员
 *
 * 创建问卷（发通知）和详情页（算目标人数）都要用同一套口径，抽到公共层避免两处漂移。
 */
export async function resolveTargetUserIds(
  audience: string,
  teamOwnerId: string | null
): Promise<string[]> {
  const prisma = await getPrisma()
  if (audience === 'TEAM' && teamOwnerId) {
    const members = await prisma.user.findMany({
      where: { OR: [{ id: teamOwnerId }, { billingOwnerId: teamOwnerId }] },
      select: { id: true },
    })
    return members.map((m) => m.id)
  }
  const users = await prisma.user.findMany({ where: { status: 'NORMAL' }, select: { id: true } })
  return users.map((u) => u.id)
}
