import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { creditPoints, creditBeans, activateSubscription } from '@/lib/billing/wallet'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { checkRateLimit } from '@/lib/rate-limit'

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const rate = checkRateLimit(`redeem:user:${authUser.userId}`, {
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
  })
  if (!rate.allowed) {
    throw new ApiHandlerError('兑换尝试过于频繁，请稍后再试', 429)
  }

  const { code } = await request.json()
  if (!code || typeof code !== 'string') {
    throw new ApiHandlerError('请输入兑换码', 400)
  }

  const prisma = await getPrisma()
  const normalizedCode = code.trim().toUpperCase()
  const cardKey = await prisma.cardKey.findUnique({
    where: { code: normalizedCode },
  })

  if (!cardKey) {
    throw new ApiHandlerError('兑换码不存在', 404)
  }
  if (cardKey.status === 'USED') {
    throw new ApiHandlerError('兑换码已被使用', 400)
  }
  if (cardKey.status === 'EXPIRED') {
    throw new ApiHandlerError('兑换码已过期', 400)
  }
  if (cardKey.expiresAt && cardKey.expiresAt < new Date()) {
    await prisma.cardKey.update({
      where: { id: cardKey.id },
      data: { status: 'EXPIRED' },
    })
    throw new ApiHandlerError('兑换码已过期', 400)
  }

  await prisma.$transaction(async (tx) => {
    // 原子认领：只允许从读到的原状态核销，并发双兑时第二个事务 count=0 直接失败
    // 过期条件进认领（Q-D11）：读快照后到核销前卡密过期的话，count=0 拒绝到账
    const claimed = await tx.cardKey.updateMany({
      where: {
        id: cardKey.id,
        status: cardKey.status,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: {
        status: 'USED',
        usedByUserId: authUser.userId,
        usedAt: new Date(),
      },
    })
    if (claimed.count === 0) {
      // 认领失败可能是并发已核销，也可能是读后过期 —— 重读给出准确文案
      const cur = await tx.cardKey.findUnique({
        where: { id: cardKey.id },
        select: { status: true, expiresAt: true },
      })
      if (cur && (cur.status === 'EXPIRED' || (cur.expiresAt && cur.expiresAt <= new Date()))) {
        throw new ApiHandlerError('兑换码已过期', 400)
      }
      throw new ApiHandlerError('兑换码已被使用', 400)
    }

    if (cardKey.type === 'SUBSCRIPTION') {
      // 订阅卡密：统一走 activateSubscription——积分作为订阅赠送一次性发放（SUBSCRIPTION 流水），
      // 不再走上面的通用 creditPoints 分支，杜绝"订阅激活 + 积分包"双发
      await activateSubscription({
        userId: authUser.userId,
        planName: `订阅卡（${cardKey.durationDays} 天）`,
        durationDays: cardKey.durationDays || 0,
        grantPoints: cardKey.pointsValue ?? 0,
        grantBeans: cardKey.beansValue ?? 0,
        freeImageDays: cardKey.freeImageDays ?? undefined,
        freeImageSourceKey: `card:${cardKey.id}`,
        source: '卡密兑换',
        tx,
      })
    } else {
      if (cardKey.pointsValue && cardKey.pointsValue > 0) {
        await creditPoints({ userId: authUser.userId, amount: cardKey.pointsValue, description: `卡密兑换：${normalizedCode}`, tx })
      }

      if (cardKey.type === 'BEANS_PACKAGE' && cardKey.beansValue && cardKey.beansValue > 0) {
        await creditBeans({ userId: authUser.userId, amount: cardKey.beansValue, description: `豆卡密兑换：${normalizedCode}`, tx })
      }
    }
  })

  const updatedUser = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: { points: true, beans: true, billingType: true, subscriptionExpiryAt: true },
  })

  return success(
    {
      points: updatedUser?.points ?? 0,
      beans: updatedUser?.beans ?? 0,
      billingType: updatedUser?.billingType ?? 'POINTS',
      subscriptionExpiryAt: updatedUser?.subscriptionExpiryAt?.toISOString() ?? null,
    },
    '兑换成功'
  )
})
