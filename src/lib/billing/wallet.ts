import { getPrisma } from '@/lib/prisma'
import { grantFreeImageTime } from '@/lib/promotions/free-image-grants'
import { FREE_IMAGE_DAY_MINUTES } from '@/lib/promotions/free-image'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { createInviteRewardForOrder } from '@/lib/invite/policy'
import { roundPoints } from '@/lib/pricing'
import { resolveBillingOwner, getTeamLimitState, addTeamSpend } from '@/lib/billing/team'

type Tx = Prisma.TransactionClient

type PointLogType = 'RECHARGE' | 'DEDUCTION' | 'SUBSCRIPTION' | 'ADMIN_ADJUST' | 'BONUS'
type BeansLogType = 'RECHARGE' | 'DEDUCTION' | 'SUBSCRIPTION' | 'ADMIN_ADJUST' | 'BONUS'

interface DeductPointsInput {
  /**
   * 所属执行任务（CanvasRun.id）。
   *
   * 有了它，积分流水就能和「调用记录 / 生成记录 / 任务」串成一条链：
   * 用户看到一笔扣费 → 点进去能看到是哪个任务、哪次调用、用了什么模型。
   * 没有任务上下文的扣费（充值、后台调整）不传。
   */
  runId?: string
  userId: string
  /**
   * 计费归属（企业团队共享池）：钱从谁的钱包扣。缺省 = 自付（userId）。
   *
   * 为什么在 wallet 层接收而不是各调用点自己解析：
   * 扣费点分散在 charge-run / canvas / tools / mcp 四处，各解析一遍必然漂移；
   * 统一在这里解析，所有入口自动获得团队计费能力。
   * 账本同时记 userId（谁花的）与 billingOwnerId（谁出的钱）。
   */
  billingOwnerId?: string | null
  amount: number
  description: string
  type?: PointLogType
  tx?: Tx
}

interface DeductBeansInput {
  /**
   * 所属执行任务（CanvasRun.id）。
   *
   * 有了它，积分流水就能和「调用记录 / 生成记录 / 任务」串成一条链：
   * 用户看到一笔扣费 → 点进去能看到是哪个任务、哪次调用、用了什么模型。
   * 没有任务上下文的扣费（充值、后台调整）不传。
   */
  runId?: string
  userId: string
  /** 计费归属（企业团队共享池）：钱从谁的钱包扣。缺省 = 自付（userId）。 */
  billingOwnerId?: string | null
  amount: number
  description: string
  type?: BeansLogType
  tx?: Tx
}

interface CreditInput {
  /**
   * 所属执行任务（CanvasRun.id）。
   *
   * 有了它，积分流水就能和「调用记录 / 生成记录 / 任务」串成一条链：
   * 用户看到一笔扣费 → 点进去能看到是哪个任务、哪次调用、用了什么模型。
   * 没有任务上下文的扣费（充值、后台调整）不传。
   */
  runId?: string
  userId: string
  /** 计费归属：到账进谁的池子（null=自付）。团队模式下由老板买单时赠与落进团队池。 */
  billingOwnerId?: string | null
  amount: number
  description: string
  type?: PointLogType
  tx?: Tx
}

interface CreditBeansInput {
  /**
   * 所属执行任务（CanvasRun.id）。
   *
   * 有了它，积分流水就能和「调用记录 / 生成记录 / 任务」串成一条链：
   * 用户看到一笔扣费 → 点进去能看到是哪个任务、哪次调用、用了什么模型。
   * 没有任务上下文的扣费（充值、后台调整）不传。
   */
  runId?: string
  userId: string
  /** 计费归属：到账进谁的池子（null=自付）。 */
  billingOwnerId?: string | null
  amount: number
  description: string
  type?: BeansLogType
  tx?: Tx
}

async function withTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tx) return fn(tx)
  const prisma = await getPrisma()
  return prisma.$transaction(fn)
}

/** 统一预扣积分：原子扣减余额（防并发超额）并写 pointsLog */
export async function deductPoints(input: DeductPointsInput) {
  if (input.amount < 0) throw new Error('扣减金额不能为负')
  // 积分支持小数：入口统一规整到 2 位，避免浮点误差累积成 0.30000000000000004
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // ===== 企业团队：钱从「出资人」的钱包扣 =====
    // 在同一个事务里解析归属，避免「归属刚被改掉、钱从旧账号扣」的交错。
    const { ownerId, isTeam } = await resolveBillingOwner(input.userId, tx)
    const billingOwnerId = input.billingOwnerId !== undefined ? input.billingOwnerId : (isTeam ? ownerId : null)
    const fromId = billingOwnerId || input.userId
    // 成员日额度：仅团队共享池需要（自付没有「池子被烧光」的问题）
    if (billingOwnerId) {
      const member = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, billingOwnerId: true, teamDailyLimit: true, teamDailyBeans: true, teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true },
      })
      const team = await tx.team.findUnique({ where: { ownerId: billingOwnerId } })
      if (member && team) {
        const st = await getTeamLimitState(member, team, tx)
        if (st.limitPoints != null && st.spentPoints + input.amount > st.limitPoints + 1e-9) {
          throw new Error(`今日额度不足：本成员每天最多 ${st.limitPoints} 积分（已用 ${st.spentPoints}），请联系管理员调整`)
        }
      }
    }
    // 原子条件扣减 + 写入时 ROUND：
    //   1) 余额是小数，浮点残差会让「0.3 - 0.1 >= 0.2」判定失败（实测 0.19999999999999998）。
    //      比较时留 0.005（半分）容差，避免边界误判。
    //   2) 写入用 ROUND(...,2)，保证库里存的永远是干净的 2 位小数，残差不会跨次累积。
    // 余额不足时命中 0 行，天然防并发扣穿。
    const res = await tx.$executeRaw`
      UPDATE users
      SET points = ROUND(points - ${input.amount}, 2)
      WHERE id = ${fromId} AND ROUND(points, 2) >= ${input.amount} - 0.005
    `
    if (res === 0) {
      const exists = await tx.user.findUnique({ where: { id: fromId }, select: { points: true } })
      if (!exists) throw new Error('用户不存在')
      throw new Error(
        billingOwnerId
          ? `团队积分不足，本次需 ${input.amount} 积分，请联系管理员为团队充值`
          : `积分不足，需要 ${input.amount} 积分`,
      )
    }
    await tx.pointsLog.create({
      data: {
        userId: input.userId,
        // 谁出的钱（null=自付）。userId 仍是「谁花的」，两个身份分开记。
        billingOwnerId,
        amount: -input.amount,
        type: input.type || 'DEDUCTION',
        description: input.description,
        runId: input.runId,
      },
    })
    // 成员日额度累加（跨天自动重置）
    if (billingOwnerId) await addTeamSpend(tx, input.userId, input.amount, 0)
  })
}

/** 统一退款积分：退回余额并写 pointsLog（正数 amount） */
export async function refundPoints(input: DeductPointsInput) {
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // 退款必须退给**当初扣钱的那个账号**，否则会把钱退错人
    // （团队场景下 = 从团队池扣、退给员工个人 —— 直接的资金错配，且不可逆）。
    // 因此这里不接受调用方传的归属，一律按当前归属重新解析，保证口径自洽。
    const { ownerId, isTeam } = await resolveBillingOwner(input.userId, tx)
    const billingOwnerId = input.billingOwnerId !== undefined ? input.billingOwnerId : (isTeam ? ownerId : null)
    const toId = billingOwnerId || input.userId
    const user = await tx.user.findUnique({ where: { id: toId } })
    if (!user) throw new Error('用户不存在')
    await tx.$executeRaw`UPDATE users SET points = ROUND(points + ${input.amount}, 2) WHERE id = ${toId}`
    await tx.pointsLog.create({
      data: {
        userId: input.userId,
        billingOwnerId,
        amount: input.amount,
        type: input.type || 'RECHARGE',
        description: input.description,
        runId: input.runId,
      },
    })
    // 退还当日额度占用（否则「失败 → 重试」会把成员额度白白吃掉）
    if (billingOwnerId) await addTeamSpend(tx, input.userId, -input.amount, 0)
  })
}

/** 统一到账积分：充值/奖励/调整（正数 amount） */
export async function creditPoints(input: CreditInput) {
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // 到账进谁的池子：显式 billingOwnerId 优先（团队由老板买单时赠与落团队池），否则自付。
    // 注意这里**不**自动解析归属 —— 充值/奖励是「钱进来」，进谁的池子必须显式指定，
    // 不能像扣费那样跟着当前归属走（否则改归属会把已到账的钱搬走）。
    const toId = input.billingOwnerId || input.userId
    await tx.$executeRaw`UPDATE users SET points = ROUND(points + ${input.amount}, 2) WHERE id = ${toId}`
    await tx.pointsLog.create({
      data: {
        userId: input.userId,
        billingOwnerId: input.billingOwnerId ?? null,
        amount: input.amount,
        type: input.type || 'RECHARGE',
        description: input.description,
        runId: input.runId,
      },
    })
  })
}

/** 预扣豆：原子扣减（防并发超额）并写 beansLog */
export async function deductBeans(input: DeductBeansInput) {
  if (input.amount < 0) throw new Error('扣减金额不能为负')
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // 同积分：钱从出资人扣（团队共享池）；豆与积分各自独立校验额度
    const { ownerId, isTeam } = await resolveBillingOwner(input.userId, tx)
    const billingOwnerId = input.billingOwnerId !== undefined ? input.billingOwnerId : (isTeam ? ownerId : null)
    const fromId = billingOwnerId || input.userId
    if (billingOwnerId) {
      const member = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, billingOwnerId: true, teamDailyLimit: true, teamDailyBeans: true, teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true },
      })
      const team = await tx.team.findUnique({ where: { ownerId: billingOwnerId } })
      if (member && team) {
        const st = await getTeamLimitState(member, team, tx)
        if (st.limitBeans != null && st.spentBeans + input.amount > st.limitBeans + 1e-9) {
          throw new Error(`今日视频额度不足：本成员每天最多 ${st.limitBeans} 豆（已用 ${st.spentBeans}），请联系管理员调整`)
        }
      }
    }
    const res = await tx.$executeRaw`
      UPDATE users
      SET beans = ROUND(beans - ${input.amount}, 2)
      WHERE id = ${fromId} AND ROUND(beans, 2) >= ${input.amount} - 0.005
    `
    if (res === 0) {
      const exists = await tx.user.findUnique({ where: { id: fromId }, select: { beans: true } })
      if (!exists) throw new Error('用户不存在')
      throw new Error(
        billingOwnerId
          ? `团队豆不足，本次需 ${input.amount} 豆，请联系管理员为团队充值`
          : `豆不足，需要 ${input.amount} 豆`,
      )
    }
    await tx.beansLog.create({
      data: {
        userId: input.userId,
        billingOwnerId,
        amount: -input.amount,
        type: input.type || 'DEDUCTION',
        description: input.description,
        runId: input.runId,
      },
    })
    if (billingOwnerId) await addTeamSpend(tx, input.userId, 0, input.amount)
  })
}

/** 退豆 */
export async function refundBeans(input: DeductBeansInput) {
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // 同积分退款：必须退给当初扣钱的账号
    const { ownerId, isTeam } = await resolveBillingOwner(input.userId, tx)
    const billingOwnerId = input.billingOwnerId !== undefined ? input.billingOwnerId : (isTeam ? ownerId : null)
    const toId = billingOwnerId || input.userId
    await tx.$executeRaw`UPDATE users SET beans = ROUND(beans + ${input.amount}, 2) WHERE id = ${toId}`
    await tx.beansLog.create({
      data: {
        userId: input.userId,
        billingOwnerId,
        amount: input.amount,
        type: input.type || 'RECHARGE',
        description: input.description,
        runId: input.runId,
      },
    })
    if (billingOwnerId) await addTeamSpend(tx, input.userId, 0, -input.amount)
  })
}

/**
 * 一次生成调用的预扣：积分 + 豆在同一事务里扣，任一失败整体回滚（Q-D01）。
 *
 * 以前 chargeRun 分两次调用 deductPoints / deductBeans：豆扣失败（余额校验只是普通读，
 * 并发可穿透）时函数直接 throw，调用方拿不到 run 对象 → 已扣的积分没有退款路径。
 * 收口到 wallet 层的唯一组合入口，所有「两币种一起预扣」的调用方共用。
 */
export async function deductRunCharge(input: {
  userId: string
  points: number
  beans: number
  description: string
  runId?: string
}) {
  if (input.points < 0 || input.beans < 0) throw new Error('扣减金额不能为负')
  if (input.points <= 0 && input.beans <= 0) return
  return withTx(undefined, async (tx) => {
    if (input.points > 0) {
      await deductPoints({ userId: input.userId, amount: input.points, description: input.description, runId: input.runId, tx })
    }
    if (input.beans > 0) {
      await deductBeans({ userId: input.userId, amount: input.beans, description: input.description, runId: input.runId, tx })
    }
  })
}
/** 到账豆 */
export async function creditBeans(input: CreditBeansInput) {
  input = { ...input, amount: roundPoints(input.amount) }
  if (input.amount <= 0) return
  return withTx(input.tx, async (tx) => {
    // 同积分：到账进谁的池子必须显式指定，不自动跟随当前归属
    const toId = input.billingOwnerId || input.userId
    await tx.$executeRaw`UPDATE users SET beans = ROUND(beans + ${input.amount}, 2) WHERE id = ${toId}`
    await tx.beansLog.create({
      data: {
        userId: input.userId,
        billingOwnerId: input.billingOwnerId ?? null,
        amount: input.amount,
        type: input.type || 'RECHARGE',
        description: input.description,
        runId: input.runId,
      },
    })
  })
}

// ===== 订阅（方案A：订阅 = 期内一次性赠送积分）=====

export interface ActivateSubscriptionInput {
  userId: string
  /**
   * 计费归属：订阅**赠送的积分/豆进谁的池子**。
   * 企业团队下由老板买单时，赠送额度应落进团队池（员工账号上），否则员工拿到订阅
   * 却在团队模式下用不到（余额校验看的是 owner）。缺省 = 自付（userId）。
   */
  billingOwnerId?: string | null
  planName: string
  durationDays: number
  grantPoints?: number
  grantBeans?: number
  /** 订阅套餐附带的「免费无限生图」天数（3/5/10）；>0 时顺延 freeImageUntil */
  freeImageDays?: number
  freeImageSourceKey?: string
  freeImageOperatorId?: string
  /** 入口来源（写进流水描述）：在线充值 / 卡密兑换 / 管理员操作 */
  source?: string
  tx?: Tx
}

/**
 * 激活/续期订阅（单一入口，支付回调与卡密兑换共用）：
 * - 期内续费 = 延期：expiryAt = max(旧到期, now) + durationDays
 * - 赠送积分/豆一次性发放（SUBSCRIPTION 流水），期内不重复发
 * - 写 billingType + 到期/激活时间 + 发放全部在同一事务，防并发双发
 */
export async function activateSubscription(input: ActivateSubscriptionInput): Promise<{ expiryAt: Date }> {
  if (!Number.isFinite(input.durationDays) || input.durationDays <= 0) {
    throw new Error('订阅时长必须大于 0 天')
  }
  return withTx(input.tx, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { subscriptionExpiryAt: true, freeImageUntil: true },
    })
    if (!user) throw new Error('用户不存在')

    const now = new Date()
    // 期内续费顺延（按旧到期日往后加），过期/首次购买从当下起算
    const base = user.subscriptionExpiryAt && user.subscriptionExpiryAt > now ? user.subscriptionExpiryAt : now
    const expiryAt = new Date(base.getTime() + input.durationDays * 24 * 60 * 60 * 1000)

    const freeImageDays = Number(input.freeImageDays) > 0 ? Number(input.freeImageDays) : 0
    await tx.user.update({
      where: { id: input.userId },
      data: {
        billingType: 'SUBSCRIPTION',
        subscriptionExpiryAt: expiryAt,
        subscriptionActivatedAt: now,
      },
      select: { id: true },
    })

    if (freeImageDays > 0) {
      await grantFreeImageTime({
        userId: input.userId,
        source: 'SUBSCRIPTION',
        sourceKey: input.freeImageSourceKey ?? randomUUID(),
        minutes: freeImageDays * FREE_IMAGE_DAY_MINUTES,
        description: `${input.planName} · 赠送 ${freeImageDays} 天生图时长`,
        operatorId: input.freeImageOperatorId,
        now,
        tx,
      })
    }

    const desc = `订阅赠送：${input.planName}${input.source ? `（${input.source}）` : ''}，${input.durationDays} 天${freeImageDays > 0 ? `，含生图时长 ${freeImageDays} 天` : ''}`
    if (input.grantPoints && input.grantPoints > 0) {
      // 赠送打到「出资人」的池子（团队模式下 = 团队池），否则员工拿到订阅却用不到
      await creditPoints({ userId: input.userId, billingOwnerId: input.billingOwnerId ?? null, amount: input.grantPoints, type: 'SUBSCRIPTION', description: desc, tx })
    }
    if (input.grantBeans && input.grantBeans > 0) {
      await creditBeans({ userId: input.userId, billingOwnerId: input.billingOwnerId ?? null, amount: input.grantBeans, type: 'SUBSCRIPTION', description: desc, tx })
    }
    return { expiryAt }
  })
}

/**
 * 惰性到期检查：已过期（含历史遗留的 SUBSCRIPTION 且无到期时间）则原子回滚为 POINTS。
 * 已发放的订阅积分保留不回收。挂载在 user/profile GET 与 login，零运维成本。
 */
export async function checkSubscriptionExpiry(userId: string, tx?: Tx): Promise<boolean> {
  return withTx(tx, async (tx) => {
    const res = await tx.user.updateMany({
      where: {
        id: userId,
        billingType: 'SUBSCRIPTION',
        OR: [{ subscriptionExpiryAt: { lt: new Date() } }, { subscriptionExpiryAt: null }],
      },
      data: { billingType: 'POINTS' },
    })
    return res.count > 0
  })
}

/**
 * 平台级到期回滚（台账 Q-603）：单用户版挂在 login/profile 上做惰性检查，
 * 但长期不访问这两个接口的账号会让 `users.billingType` 一直停在 SUBSCRIPTION。
 * 显示层目前都二次判了 `subscriptionExpiryAt`，所以这不是用户可见 bug，
 * 而是**库里不变式为假** —— 任何新代码只要按 `billingType` 过滤就会拿到虚高结果。
 *
 * 与单用户版共用同一份 where 谓词（含「历史遗留无到期时间也回滚」那条），
 * 不再另写一套判断 —— 两处标准漂移过一次已经出过账实不符（见 maintenance 收敛注释）。
 */
export async function expireDueSubscriptions(tx?: Tx): Promise<number> {
  return withTx(tx, async (tx) => {
    const res = await tx.user.updateMany({
      where: {
        billingType: 'SUBSCRIPTION',
        OR: [{ subscriptionExpiryAt: { lt: new Date() } }, { subscriptionExpiryAt: null }],
      },
      data: { billingType: 'POINTS' },
    })
    return res.count
  })
}

/** ===== 画布任务级资金账本（hold）· 防崩溃丢预扣 =====
 * 画布执行是「顶层预扣 → SSE 流 → 结束退差额」两个独立事务，中间进程崩溃/重启会让预扣的钱蒸发。
 * 预扣时 openHold 建账；所有结束路径 settleHold 对平（退差额 + 置 SETTLED）；
 * reconcileOpenHolds 惰性扫描遗留 OPEN 的 hold 兜底退款（挂 profile/login 懒检查，零运维）。
 */

export async function openHold(userId: string, runId: string, points: number, beans: number, tx?: Tx) {
  return withTx(tx, async (tx) => {
    if (points <= 0 && beans <= 0) return null
    // 记下「这笔预扣从谁的钱包扣的」，退款时才能退给同一个账号。
    // 不记的话：团队会员的画布预扣会退回到成员个人账号（钱从团队池扣、退给个人）——
    // 直接的资金错配，且不可逆。
    const { ownerId, isTeam } = await resolveBillingOwner(userId, tx)
    return tx.billingHold.create({
      data: {
        userId,
        billingOwnerId: isTeam ? ownerId : null,
        runId, points: Math.max(0, points), beans: Math.max(0, beans), status: 'OPEN',
      },
    })
  })
}

/** 画布结束（任一终态路径均已退完差额后）把 hold 置 SETTLED，标识该预扣已对平，避免惰性对账重复退 */
export async function settleHold(runId: string, tx?: Tx) {
  return withTx(tx, async (tx) => {
    await tx.billingHold.updateMany({
      where: { runId, status: 'OPEN' },
      data: { status: 'SETTLED' },
    })
  })
}

/** 单条 OPEN hold 的对账：按「预扣 - run 实耗」补退差额后置 SETTLED。
 *
 * 这是「进程崩溃/重启导致 settleHold 未执行」时**唯一**的兜底实现。
 * 历史上有两份手写（本函数 + maintenance.ts 的「僵死 OPEN hold 兜底」），文案一字不差
 * 却已漂移出实质差异，只修其中一处等于没修：
 *   - maintenance 版把 PAUSED 也按未消耗全退 → 与「暂停退未消耗」路径双退；
 *   - maintenance 版不把僵死 RUNNING 标 FAILED → run 永远挂在运行中；
 *   - 两版对「run 不存在」的处理相反（wallet 版永久跳过 = 漏退）。
 * 现在收敛为这一处，判定标准只有一份：两个入口（用户访问 profile / 定时维护）共用。
 */
export async function reconcileHold(
  hold: { id: string; runId: string; userId: string; billingOwnerId: string | null; points: number; beans: number },
  options?: { refundOwnerId?: string; now?: number },
): Promise<{ refunded: boolean }> {
  const prisma = await getPrisma()
  const run = await prisma.canvasRun.findUnique({
    where: { id: hold.runId },
    select: { costPoints: true, costBeans: true, status: true, updatedAt: true },
  })
  // run 已被清理（retention 删终态 run）或根本没查到：实耗无从得知，
  // 按「全部未消耗」退，而不是永久跳过 —— 否则用户的钱静默留在平台账上。
  const STALE_RUN_MS = 30 * 60 * 1000
  const now = options?.now ?? Date.now()
  const stale = run ? now - run.updatedAt.getTime() > STALE_RUN_MS : true
  // RUNNING/PAUSED 且最近还在更新 → 确实在跑或已暂停等续跑，等它自己归位，别抢。
  // PAUSED 必须跳过：暂停路径已退过未消耗部分并 settleHold，恢复续跑会重新预扣。
  if (run && (run.status === 'RUNNING' || run.status === 'PAUSED') && !stale) return { refunded: false }
  // 僵死的 RUNNING：实耗无从得知（节点没写完就崩了），按「全部未消耗」退，
  // 宁可多退给用户，也不能把预扣吞掉。
  const consumedPoints = !run || run.status === 'RUNNING' ? 0 : (run.costPoints || 0)
  const consumedBeans = !run || run.status === 'RUNNING' ? 0 : (run.costBeans || 0)
  const refundPoints = hold.points - consumedPoints
  const refundBeans = hold.beans - consumedBeans
  // 退给「当初预扣的账号」：团队会员的预扣要退回团队池，不能退给成员个人
  const refundOwnerId = options?.refundOwnerId ?? hold.billingOwnerId ?? hold.userId
  // SQLite 单写；事务内 UPDATE 同一 hold 天然幂等，并发对账也不会重复退
  await prisma.$transaction(async (tx) => {
    const cur = await tx.billingHold.findUnique({ where: { id: hold.id }, select: { status: true } })
    if (!cur || cur.status !== 'OPEN') return
    if (refundPoints > 0) {
      await tx.$executeRaw`UPDATE users SET points = ROUND(points + ${refundPoints}, 2) WHERE id = ${refundOwnerId}`
      await tx.pointsLog.create({
        data: { userId: hold.userId, billingOwnerId: hold.billingOwnerId ?? null, amount: refundPoints, type: 'RECHARGE', description: '任务中断遗留预扣对账退回', category: null },
      })
    }
    if (refundBeans > 0) {
      await tx.$executeRaw`UPDATE users SET beans = ROUND(beans + ${refundBeans}, 2) WHERE id = ${refundOwnerId}`
      await tx.beansLog.create({
        data: { userId: hold.userId, billingOwnerId: hold.billingOwnerId ?? null, amount: refundBeans, type: 'RECHARGE', description: '任务中断遗留预扣对账退回', category: null },
      })
    }
    await tx.billingHold.update({ where: { id: hold.id }, data: { status: 'SETTLED' } })
    // 僵死 run 一并标失败：否则它会一直挂在「运行中」，用户看不到结果也等不到
    if (run && run.status === 'RUNNING') {
      await tx.canvasRun.update({
        where: { id: hold.runId },
        data: { status: 'FAILED', error: '任务中断（服务重启或异常退出），预扣已退回' },
      }).catch(() => { /* run 可能已被清理 */ })
    }
  })
  return { refunded: true }
}

/**
 * 画布终态收口（Q-D03）：退「预扣 - 实耗」差额 + 置 hold SETTLED，同一事务原子完成。
 *
 * 以前退款与 settleHold 是两步，退款 `.catch` 吞错后 hold 仍被结算 → 对账兜底
 * `reconcileHold` 永不重试，差额永久丢失。现在任一退款失败 → 整体回滚、hold 保持
 * OPEN，由 reconcileHold 按「hold - run 实耗」重试同一差额（hold 状态幂等，不会双退）。
 * 前提不变式：存在可退差额（budget > consumed）⇒ openHold 建过 hold。
 * 没有 hold（runId 无对应记录，如预算为 0）时仅退款，hold 更新 0 行不报错。
 */
export async function settleHoldWithRefund(input: {
  runId: string
  userId: string
  refundPoints: number
  refundBeans: number
  pointsDescription: string
  beansDescription: string
}) {
  const refundPointAmt = roundPoints(input.refundPoints)
  const refundBeanAmt = roundPoints(input.refundBeans)
  if (refundPointAmt <= 0 && refundBeanAmt <= 0) {
    // 没有差额可退：只结算 hold，行为与原 settleHold 一致
    await settleHold(input.runId)
    return
  }
  await withTx(undefined, async (tx) => {
    if (refundPointAmt > 0) {
      await refundPoints({ userId: input.userId, amount: refundPointAmt, description: input.pointsDescription, runId: input.runId, tx })
    }
    if (refundBeanAmt > 0) {
      await refundBeans({ userId: input.userId, amount: refundBeanAmt, description: input.beansDescription, runId: input.runId, tx })
    }
    await tx.billingHold.updateMany({
      where: { runId: input.runId, status: 'OPEN' },
      data: { status: 'SETTLED' },
    })
  })
}

/** 惰性对账：找出该用户所有仍未 SETTLED 的 OPEN hold，逐条走 reconcileHold 兜底退款。
 * 适用于进程崩溃/重启导致 settleHold 未执行的情况：run 的 costPoints/costBeans 已写实耗，
 * 这里把 hold.points - run.costPoints 差额退回并把 hold 置 SETTLED，保证用户预扣的钱不因崩溃蒸发。
 */
export async function reconcileOpenHolds(userId: string): Promise<void> {
  const prisma = await getPrisma()
  // 该用户名下（含他作为出资人代付的团队预扣）的未平 hold。
  // 两个条件都要：团队会员的 hold.userId 是成员、billingOwnerId 才是出资人，
  // 只按 userId 查会漏掉「出资人视角」的兜底（老板登录时对不到团队的僵死预扣）。
  const holds = await prisma.billingHold.findMany({
    where: { status: 'OPEN', OR: [{ userId }, { billingOwnerId: userId }] },
    take: 50,
  })
  if (holds.length === 0) return
  for (const hold of holds) {
    try {
      await reconcileHold(hold)
    } catch (e) {
      console.error('画布对账 hold 异常(跳过,下轮重试):', e)
    }
  }
}

export async function adjustPoints(
  userId: string,
  amount: number,
  description?: string | null,
  tx?: Tx,
  options?: { type?: 'ADMIN_ADJUST' | 'BONUS' | 'RECHARGE'; billingOwnerId?: string | null },
) {
  amount = roundPoints(amount)
  if (amount === 0) return
  return withTx(tx, async (tx) => {
    if (amount < 0) {
      // 条件扣减：余额不足时 count=0，避免读-算-写竞态把余额扣成负数
      const res = await tx.$executeRaw`
        UPDATE users
        SET points = ROUND(points + ${amount}, 2)
        WHERE id = ${userId} AND ROUND(points, 2) >= ${-amount} - 0.005
      `
      if (res === 0) {
        const exists = await tx.user.findUnique({ where: { id: userId }, select: { points: true } })
        if (!exists) throw new Error('用户不存在')
        throw new Error('调整后积分不能为负数')
      }
    } else {
      const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!exists) throw new Error('用户不存在')
      await tx.$executeRaw`UPDATE users SET points = ROUND(points + ${amount}, 2) WHERE id = ${userId}`
    }
    await tx.pointsLog.create({
      data: {
        userId,
        // 归属只在调用方显式指定时写：扣回类操作（如邀请返利扣回）需要把流水记到
        // 「实际出资的账号」上，否则对账时看不出钱是从团队池扣的。
        billingOwnerId: options?.billingOwnerId ?? null,
        amount,
        type: options?.type || 'ADMIN_ADJUST',
        description: description || null,
      },
    })
  })
}

/**
 * 管理员手工调整视频豆（积分 adjustPoints 的豆版对称实现）。
 *
 * 为什么必须补上：此前后台只有「调整积分」，豆没有对等入口 —— 管理员既改不了豆，
 * 也无法用统一的 ADMIN_ADJUST 流水解释余额变动（只能靠裸写 beansLog，绕过 wallet 事务）。
 * 有了它，豆的每一笔余额变化都有成对流水，和积分一样可对账。
 */
export async function adjustBeans(userId: string, amount: number, description?: string | null, tx?: Tx) {
  amount = roundPoints(amount)
  if (amount === 0) return
  return withTx(tx, async (tx) => {
    if (amount < 0) {
      // 条件扣减：余额不足时 count=0，避免读-算-写竞态把余额扣成负数
      const res = await tx.$executeRaw`
        UPDATE users
        SET beans = ROUND(beans + ${amount}, 2)
        WHERE id = ${userId} AND ROUND(beans, 2) >= ${-amount} - 0.005
      `
      if (res === 0) {
        const exists = await tx.user.findUnique({ where: { id: userId }, select: { beans: true } })
        if (!exists) throw new Error('用户不存在')
        throw new Error('调整后视频豆不能为负数')
      }
    } else {
      const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!exists) throw new Error('用户不存在')
      await tx.$executeRaw`UPDATE users SET beans = ROUND(beans + ${amount}, 2) WHERE id = ${userId}`
    }
    await tx.beansLog.create({
      data: {
        userId,
        amount,
        type: 'ADMIN_ADJUST',
        description: description || null,
      },
    })
  })
}

/** 原子积分到账 + 订单状态变更（充值回调用；订阅订单走 activateSubscription 一次性发放） */
export async function creditRechargePoints(
  orderId: string,
  options: { tradeNo?: string | null; tx?: Tx; sourceLabel?: string; operatorId?: string }
) {
  return withTx(options.tx, async (tx) => {
    // 认领前先读订单快照（字段不可变，无并发问题）
    const order = await tx.rechargeOrder.findUnique({
      where: { id: orderId },
      select: {
        name: true,
        isSubscription: true,
        durationDays: true,
        freeImageDays: true,
        userId: true,
        priceCents: true,
        points: true,
        beans: true,
      },
    })
    if (!order) return false
    // PENDING→PAID 原子认领：重复回调 count=0 直接跳过，天然幂等
    const claimed = await tx.rechargeOrder.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'PAID', paidAt: new Date(), tradeNo: options.tradeNo },
    })
    if (claimed.count === 0) return false

    // 邀请返利：支付成功即为被邀请人登记一条待发放返利（同事务，失败则整体回滚）
    await createInviteRewardForOrder(tx, {
      id: orderId,
      userId: order.userId,
      priceCents: order.priceCents,
      points: order.points,
      beans: order.beans,
    })

    // 订阅订单：激活订阅并一次性发放积分/豆（同一事务，认领+发放要么都成要么都回滚）
    if (order.isSubscription && order.durationDays && order.durationDays > 0) {
      await activateSubscription({
        userId: order.userId,
        planName: order.name,
        durationDays: order.durationDays,
        grantPoints: order.points,
        grantBeans: order.beans,
        freeImageDays: order.freeImageDays ?? undefined,
        freeImageSourceKey: `order:${orderId}`,
        freeImageOperatorId: options.operatorId,
        source: options.sourceLabel ?? '在线充值',
        tx,
      })
      return true
    }

    if (order.points > 0) {
      await tx.$executeRaw`UPDATE users SET points = ROUND(points + ${order.points}, 2) WHERE id = ${order.userId}`
      await tx.pointsLog.create({
        data: { userId: order.userId, amount: order.points, type: 'RECHARGE', description: `${options.sourceLabel ?? '在线充值'}：${order.name}` },
      })
    }
    if (order.beans > 0) {
      await tx.$executeRaw`UPDATE users SET beans = ROUND(beans + ${order.beans}, 2) WHERE id = ${order.userId}`
      await tx.beansLog.create({
        data: { userId: order.userId, amount: order.beans, type: 'RECHARGE', description: `${options.sourceLabel ?? '在线充值'}：${order.name}` },
      })
    }
    return true
  })
}
