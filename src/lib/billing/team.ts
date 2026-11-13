import { getPrisma } from '@/lib/prisma'
import { localDayKey } from '@/lib/day-key'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/**
 * 企业团队计费归属（共享余额池）。
 *
 * ===== 它解决什么 =====
 * 「老板充值、员工使用」：员工的消费要从**老板的余额**扣，而不是自己那 0 余额的账号。
 *
 * ===== 设计要点（为什么这样做）=====
 * 1. **归属是自引用、默认 null**：`User.billingOwnerId=null` 即自付 —— 存量用户与所有
 *    新注册用户行为完全不变，不需要任何数据回填。opt-in，不进团队就永不走新分支。
 * 2. **扣费仍是对单行做条件 UPDATE**：只是把 id 从「自己」换成「出资人」。
 *    防并发超额的那套 `WHERE id=? AND points>=?` 语义不变，**不引入跨行事务**。
 * 3. **账本记两个身份**：`userId` = 谁花的（不变），`billingOwnerId` = 谁出的钱（新增）。
 *    这样「老板看团队消费」= `where billingOwnerId=老板`，而所有现有查询一行都不用改。
 */

/** 解析结果：钱从哪个账号扣 + 是否团队共享池 */
export interface BillingOwner {
  /** 实际扣费的账号 id（可能是自己，也可能是团队 owner） */
  ownerId: string
  /** true = 走团队共享池（用于账本归属 + 额度校验） */
  isTeam: boolean
}

/**
 * 账本归属注解：给一笔流水标「谁出的钱、以及出钱人叫什么」。
 *
 * 为什么需要它：`billingOwnerId=null` 只说明「自付」，但同一条流水在
 * 老板自己的账本里是「我花的」，在成员账本里是「公司出的」——
 * 前端要按视角显示「我的余额 / 团队（张三）」，不能只看 null 一刀切。
 * 这里统一产出 `paidBy`，前端不再各自推导，避免口径分叉。
 */
export function ledgerPayer(
  billingOwnerId: string | null | undefined,
  selfId: string,
  ownerName?: string | null,
): { paidBy: 'self' | 'team'; payerName: string | null } {
  if (!billingOwnerId || billingOwnerId === selfId) return { paidBy: 'self', payerName: null }
  return { paidBy: 'team', payerName: ownerName?.trim() || '企业账号' }
}

/**
 * 解析某用户的计费归属。
 *
 * 传入 tx 时用调用方的事务（扣费场景必须同事务，避免归属变更与扣费交错）。
 * 归属指向的账号被删/停用时**回退为自付**而不是抛错 —— 宁可让用户扣自己的钱，
 * 也不能因为「老板账号异常」把员工的生成全堵死。
 */
export async function resolveBillingOwner(userId: string, tx?: Tx): Promise<BillingOwner> {
  const db = tx ?? (await getPrisma())
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      billingOwnerId: true,
      // teamDisabled：企业主停用该成员 → 停止团队出资（回退自付）。
      // 必须在这里判，而不是只在界面拦 —— 否则「先停用、后扣费」仍会花公司的钱。
      teamDisabled: true,
      billingOwner: { select: { id: true, status: true, ownedTeam: { select: { status: true } } } },
    },
  })
  if (!user) throw new Error('用户不存在')
  const owner = user.billingOwner
  // 归属人已停用 → 回退自付（不阻断员工使用）
  if (!owner || owner.status !== 'NORMAL') return { ownerId: userId, isTeam: false }
  // 企业主停用了该成员 → 回退自付（成员用自己充的钱继续，只是不再花公司的）
  if (user.teamDisabled) return { ownerId: userId, isTeam: false }
  // ⚠️ 团队**必须已过审**才允许共享扣费。这是资金权力的最后一道闸：
  // 只在 UI/接口层拦不够 —— 「先加成员、团队后被驳回/还在待审」的情况下，
  // 成员仍会继续扣老板的钱。所以判定放在这里，所有扣费路径自动受约束。
  if (owner.ownedTeam?.status !== 'APPROVED') return { ownerId: userId, isTeam: false }
  return { ownerId: owner.id, isTeam: true }
}

/** 同步版：已知 billingOwnerId 时直接用（避免在扣费热路径里多查一次） */
export function ownerIdFrom(billingOwnerId: string | null | undefined, selfId: string): string {
  return billingOwnerId || selfId
}

/**
 * 余额校验用的「可用余额」。
 *
 * 为什么需要这一步：各入口在扣费**之前**都有一道
 * `if (user.points < totalCost) throw 积分不足` 的前置校验。
 * 团队成员自己的余额是 0（钱在老板账上），不过这一道就会被**提前拒绝**，
 * 根本走不到 wallet 层 —— 团队功能形同虚设。
 *
 * 返回出资人的余额（团队共享池）或自己的（自付），调用方拿它做 < 比较即可。
 */
export async function resolveAvailableBalance(
  userId: string,
  tx?: Tx,
): Promise<{ points: number; beans: number; isTeam: boolean; ownerId: string }> {
  const db = tx ?? (await getPrisma())
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      points: true, beans: true, billingOwnerId: true,
      teamDisabled: true,
      billingOwner: { select: { id: true, status: true, points: true, beans: true, ownedTeam: { select: { status: true } } } },
    },
  })
  if (!user) throw new Error('用户不存在')
  const owner = user.billingOwner
  // 同 resolveBillingOwner：未过审的团队不算团队，余额判定回落到自己的账号
  // （否则会拿老板余额放行、实际扣费却回退自付 → 判定与扣费口径分叉）
  if (!owner || owner.status !== 'NORMAL' || owner.ownedTeam?.status !== 'APPROVED' || user.teamDisabled) {
    return { points: user.points, beans: user.beans, isTeam: false, ownerId: userId }
  }
  // 团队池：用出资人的余额（团队成员自己的余额不参与判定）
  return { points: owner.points, beans: owner.beans, isTeam: true, ownerId: owner.id }
}

// ===== 成员额度（防一人烧光整池）=====

/** 今日分桶键（本地日）。统一走 lib/day-key —— 与免费额度共用同一份口径。 */
export function teamDayKey(d: Date = new Date()): string {
  return localDayKey(d)
}

export interface TeamLimitCheck {
  /** null = 无限制 */
  limitPoints: number | null
  limitBeans: number | null
  spentPoints: number
  spentBeans: number
}

/**
 * 成员每日限额的三级回落：成员单独设 → 团队默认 → 不限。
 *
 * **读接口也必须用它**，不能直接回 `member.teamDailyLimit`：
 * 成员没单独设时该字段是 null，但扣费侧会回落到团队默认值。
 * 直接回 null 会让成员看到「不限」、实际却被团队默认额度拦下 ——
 * 显示与执行分叉，用户只会以为「莫名其妙不能用了」。
 */
export function effectiveTeamLimits(
  member: { teamDailyLimit?: number | null; teamDailyBeans?: number | null },
  team: { defaultDailyLimit: number; defaultDailyBeans: number } | null,
): { limitPoints: number | null; limitBeans: number | null } {
  const points = member.teamDailyLimit ?? team?.defaultDailyLimit ?? 0
  const beans = member.teamDailyBeans ?? team?.defaultDailyBeans ?? 0
  return {
    // 0/未设 = 不限，统一转成 null，避免前端把 0 渲染成「上限 0」
    limitPoints: points > 0 ? points : null,
    limitBeans: beans > 0 ? beans : null,
  }
}

/**
 * 读取成员的额度与今日已用量。
 * 成员单独设了 teamDailyLimit 用它，否则用团队默认值；0/未设 = 不限。
 */
export async function getTeamLimitState(
  member: {
    id: string
    teamDailyLimit: number | null
    /** 成员单独的豆额度（null = 用团队默认值） */
    teamDailyBeans?: number | null
    teamSpentDay: string | null
    teamSpentPoints: number
    teamSpentBeans: number
  },
  team: { defaultDailyLimit: number; defaultDailyBeans: number } | null,
  tx?: Tx,
): Promise<TeamLimitCheck> {
  // 豆与积分走**同一套三级回落**（成员 → 团队默认 → 不限），与读接口共用 effectiveTeamLimits。
  // 此前豆写死读团队默认值 → 只能给全员同一个上限，而豆最贵、最需要按人管。
  const { limitPoints, limitBeans } = effectiveTeamLimits(member, team)
  // 跨天：今天的桶被重置过，用量算 0
  const today = teamDayKey()
  const fresh = member.teamSpentDay === today
  return {
    limitPoints,
    limitBeans,
    spentPoints: fresh ? member.teamSpentPoints : 0,
    spentBeans: fresh ? member.teamSpentBeans : 0,
  }
}

/**
 * 记录成员今日消费（跨天自动重置后累加）。
 * 用 updateMany + 条件写，保证并发下不会把跨天重置写丢。
 */
export async function addTeamSpend(
  tx: Tx,
  memberId: string,
  points: number,
  beans: number,
): Promise<void> {
  // ⚠️ 不能写成 `points <= 0 && beans <= 0 return`：退款传的是**负数**
  //   （退还当日额度占用），那样会被这道 guard 吞掉，额度白扣。
  //   真实 bug：失败退款后额度没退还，成员当天额度被永久吃掉一次。
  if (points === 0 && beans === 0) return
  const today = teamDayKey()
  // 事务内读-改-写：SQLite 单写，且本函数只在自己的事务里调用，无并发窗口
  const cur = await tx.user.findUnique({
    where: { id: memberId },
    select: { teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true },
  })
  if (!cur) return
  const fresh = cur.teamSpentDay === today
  const baseP = fresh ? cur.teamSpentPoints : 0
  const baseB = fresh ? cur.teamSpentBeans : 0
  // 夹到 0：跨天重置时若传负数（退款），不能写成负用量
  await tx.user.update({
    where: { id: memberId },
    data: {
      teamSpentDay: today,
      teamSpentPoints: Math.max(0, baseP + points),
      teamSpentBeans: Math.max(0, baseB + beans),
    },
  })
}
