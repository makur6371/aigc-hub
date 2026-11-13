import { getPrisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

export interface InvitePolicyShape {
  enabled: boolean
  rewardPercent: number
  requiredUsagePercent: number
  minPaidCents: number
}

const DEFAULT_POLICY: InvitePolicyShape = {
  enabled: true,
  rewardPercent: 10,
  requiredUsagePercent: 60,
  minPaidCents: 100,
}

let cachedPolicy: InvitePolicyShape | null = null

/** 读取邀请返利策略（单例，带内存缓存；后台保存后调用 clearInvitePolicyCache 失效） */
export async function getInvitePolicy(): Promise<InvitePolicyShape> {
  if (cachedPolicy) return cachedPolicy
  const prisma = await getPrisma()
  const record = await prisma.invitePolicy.findUnique({ where: { id: 'primary' } })
  cachedPolicy = record
    ? {
        enabled: record.enabled,
        rewardPercent: record.rewardPercent,
        requiredUsagePercent: record.requiredUsagePercent,
        minPaidCents: record.minPaidCents,
      }
    : { ...DEFAULT_POLICY }
  return cachedPolicy
}

export function clearInvitePolicyCache() {
  cachedPolicy = null
}

/** 返利基数：订单发放的积分 + 豆（豆按 1:1 折算）。返利统一以积分发放 */
export function inviteRewardBasePoints(order: { points: number; beans: number }): number {
  return Math.max(0, order.points) + Math.max(0, order.beans)
}

/**
 * 支付成功后为被邀请人创建返利记录（在充值事务内调用）。
 * - 无邀请关系 / 策略关闭 / 未达最低充值门槛 → 不创建
 * - orderId 唯一，重复回调天然幂等
 */
export async function createInviteRewardForOrder(
  tx: Tx,
  order: { id: string; userId: string; priceCents: number; points: number; beans: number }
): Promise<void> {
  const policy = await getInvitePolicy()
  if (!policy.enabled) return
  if (order.priceCents < policy.minPaidCents) return

  const relation = await tx.inviteRelation.findUnique({
    where: { inviteeId: order.userId },
    select: { id: true, inviterId: true, status: true },
  })
  if (!relation || relation.status !== 'ACTIVE') return

  const rewardPoints = Math.floor((inviteRewardBasePoints(order) * policy.rewardPercent) / 100)
  if (rewardPoints <= 0) return

  const existing = await tx.inviteReward.findUnique({ where: { orderId: order.id }, select: { id: true } })
  if (existing) return

  await tx.inviteReward.create({
    data: {
      relationId: relation.id,
      orderId: order.id,
      inviteeId: order.userId,
      inviterId: relation.inviterId,
      paidAmountCents: order.priceCents,
      rewardPoints,
      requiredUsagePercent: policy.requiredUsagePercent,
      usagePercent: 0,
      status: 'PENDING',
    },
  })
}
