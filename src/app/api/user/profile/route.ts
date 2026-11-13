import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { resolveAvailableBalance, effectiveTeamLimits } from '@/lib/billing/team'
import { isTodayKey } from '@/lib/day-key'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { checkSubscriptionExpiry, reconcileOpenHolds } from '@/lib/billing/wallet'
import { settleInviteRewards } from '@/lib/invite/settle'
import { getFreeImagePassPolicy, isPassModelCovered, checkFreeImagePass } from '@/lib/promotions/free-image-pass'

export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  // 惰性订阅到期检查：个人中心是订阅状态的权威展示入口，先回滚过期订阅再查询
  await checkSubscriptionExpiry(authUser.userId).catch((e) => console.error('订阅到期检查失败:', e))
  // 惰性画布 hold 对账：兜底退回进程崩溃导致的遗留预扣（零运维）
  await reconcileOpenHolds(authUser.userId).catch((e) => console.error('画布 hold 对账失败:', e))
  // 惰性邀请返利结算：被邀请人产生消耗后，达到门槛即把返利发给邀请人（零运维，无需定时任务）
  await settleInviteRewards(authUser.userId).catch((e) => console.error('邀请返利结算失败:', e))

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: {
      id: true,
      phone: true,
      email: true,
      nickname: true,
      role: true,
      status: true,
      points: true,
      beans: true,
      billingType: true,
      subscriptionExpiryAt: true,
      subscriptionActivatedAt: true,
      freeImageUntil: true,
      freeImageGrants: { orderBy: { createdAt: 'desc' }, take: 10 },
      securityLevel: true,
      emailVerified: true,
      securityVerifiedAt: true,
      socialUid: true,
      socialProvider: true,
      createdAt: true,
      // 团队共享池：成员自己余额是 0，真实可用看在谁的池子（下面补 avail* 字段）
      billingOwnerId: true,
      // 团队成员视角：需要展示「我今日已用 / 我的上限」，而不是团队池数字
      teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true,
      teamDailyLimit: true, teamDailyBeans: true,
      passwordHash: true, // 仅用于推算 hasPassword，不直接返回 hash 本身
    },
  })

  if (!user) {
    throw new Error('用户不存在')
  }

  const totalConsumed = await prisma.pointsLog.aggregate({
    // 含团队消费：团队模式下流水记在成员名下（userId=成员），所以按 userId 聚合已覆盖；
    // 这里只是把注释写清楚，避免后人误以为要改按 billingOwnerId。
    where: { userId: authUser.userId, type: 'DEDUCTION', category: null },
    _sum: { amount: true },
  })

  // 团队共享池：余额展示 = 扣费口径（成员显示「他能用的钱」= 团队池），
  // 但 `availPoints/availBeans` 是**可用额度**，不是成员自己的资产。
  // 成员自己的钱仍然在 selfPoints/selfBeans 里，`isTeamBilling` 用来提示
  // 「这个数字是公司给的额度，不是你的余额」，前端据此切文案而不是当成自己的钱。
  const avail = await resolveAvailableBalance(authUser.userId)
  // 出钱人名字 + 团队默认额度：成员视角要能说出「谁在给我付费」，
  // 且上限必须走三级回落（成员 → 团队默认 → 不限），与扣费侧同口径 ——
  // 直接回 teamDailyLimit(null) 会把「团队默认额度」显示成「不限」。
  const owner = avail.isTeam
    ? await prisma.user.findUnique({
        where: { id: avail.ownerId },
        select: { nickname: true, phone: true, ownedTeam: { select: { defaultDailyLimit: true, defaultDailyBeans: true } } },
      })
    : null
  const ownerName = owner ? owner.nickname || owner.phone || null : null
  const memberLimits = owner ? effectiveTeamLimits(user, owner.ownedTeam) : { limitPoints: null, limitBeans: null }

  // 剥离 passwordHash，单独返回 hasPassword 标志位（避免泄露哈希本身）
  const { passwordHash, freeImageGrants, ...userWithoutHash } = user
  const passPolicy = await getFreeImagePassPolicy()
  const passModels = (await prisma.modelConfig.findMany({
    where: { isActive: true, type: 'IMAGE' },
    select: { id: true, name: true, type: true, dailyUserFreeQuota: true },
  })).filter((model) => isPassModelCovered(model, passPolicy))
  const passAvailability = passModels[0] ? await checkFreeImagePass(passModels[0], user, user.id) : null
  return {
    ...userWithoutHash,
    // 计费归属与可用余额：前端余额展示一律以 availPoints/availBeans 为准
    billingOwnerId: user.billingOwnerId,
    availPoints: avail.points,
    availBeans: avail.beans,
    isTeamBilling: avail.isTeam,
    billingOwnerName: ownerName,
    // 团队成员的自用量/上限（非成员时为 0/null，前端自付分支不读）
    // 跨天归零：teamSpentDay 是昨天的分桶键时用量算 0（与扣费侧同口径）
    teamSpentTodayPoints: isTodayKey(user.teamSpentDay) ? user.teamSpentPoints : 0,
    teamSpentTodayBeans: isTodayKey(user.teamSpentDay) ? user.teamSpentBeans : 0,
    teamDailyLimitPoints: memberLimits.limitPoints,
    teamDailyLimitBeans: memberLimits.limitBeans,
    selfPoints: user.points,
    selfBeans: user.beans,
    hasPassword: passwordHash !== '',
    securityVerifiedAt: user.securityVerifiedAt?.toISOString() ?? null,
    freeImageUntil: user.freeImageUntil?.toISOString() ?? null,
    freeImagePass: {
      enabled: passPolicy.enabled,
      limited: passPolicy.dailyUserLimit > 0 || passPolicy.dailyPlatformLimit > 0,
      reason: passAvailability?.reason ?? 'not-entitled',
      models: passModels.map(({ id, name }) => ({ id, name })),
    },
    freeImageGrants: freeImageGrants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      minutes: grant.minutes,
      description: grant.description,
      startsAt: grant.startsAt.toISOString(),
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
    })),
    subscriptionExpiryAt: user.subscriptionExpiryAt?.toISOString() ?? null,
    subscriptionActivatedAt: user.subscriptionActivatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    totalConsumed: Math.abs(totalConsumed._sum.amount ?? 0),
  }
})

export const PUT = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const { nickname } = await request.json()
  const trimmed = typeof nickname === 'string' ? nickname.trim() : ''
  if (!trimmed) {
    throw new Error('昵称不能为空')
  }
  if (trimmed.length > 20) {
    throw new Error('昵称不能超过 20 个字符')
  }

  const prisma = await getPrisma()
  const updated = await prisma.user.update({
    where: { id: authUser.userId },
    data: { nickname: trimmed },
    select: {
      id: true,
      phone: true,
      nickname: true,
      role: true,
      status: true,
      points: true,
      beans: true,
      billingType: true,
      subscriptionExpiryAt: true,
      createdAt: true,
    },
  })

  return {
    ...updated,
    subscriptionExpiryAt: updated.subscriptionExpiryAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
  }
})
