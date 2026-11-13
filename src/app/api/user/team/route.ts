import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { isTodayKey } from '@/lib/day-key'
import { effectiveTeamLimits } from '@/lib/billing/team'

/**
 * 企业团队（共享余额池）—— 查看我所在团队 / 我拥有的团队。
 *
 * 只做「谁付费」：成员账号、数据、产出全部保留，只是消费从 owner 余额扣。
 * 不做组织级数据隔离（另一个量级的改动，当前无此需求）。
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  const me = await prisma.user.findUnique({
    where: { id: authUser.userId },
      select: {
      id: true, points: true, beans: true,
      billingOwnerId: true,
      teamDailyLimit: true, teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true,
      teamDailyBeans: true,
      // ⚠️ 只取 owner 的**身份**，不取 points/beans ——
      // 成员不该看到老板的钱包数字（那是另一家公司的财务信息）。
      billingOwner: {
        select: {
          id: true, nickname: true, phone: true,
          // 团队默认额度：成员没单独设时，真实生效的是这两个值。
          // 必须取出来做回落，否则成员页会把「团队默认」显示成「不限」。
          ownedTeam: { select: { defaultDailyLimit: true, defaultDailyBeans: true } },
        },
      },
    },
  })
  if (!me) throw new ApiHandlerError('用户不存在', 404)

  // 成员每日上限（三级回落）：与扣费侧 effectiveTeamLimits 同口径。
  // 注意字段名必须保持 dailyLimit*：前端 TeamContent 读的就是这两个键。
  const memberLimits = me.billingOwner ? effectiveTeamLimits(me, me.billingOwner.ownedTeam) : null

  const ownedTeam = await prisma.team.findUnique({ where: { ownerId: me.id } })
  const members = ownedTeam
    ? await prisma.user.findMany({
        where: { billingOwnerId: me.id },
        select: {
          id: true, nickname: true, phone: true,
          teamDailyLimit: true, teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true,
          teamDailyBeans: true, teamMemberNote: true, teamDisabled: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      })
    : []

  return {
    /** 我作为「成员」所属的团队（null = 自付） */
    asMember: me.billingOwner
      ? {
          ownerId: me.billingOwner.id,
          ownerName: me.billingOwner.nickname || me.billingOwner.phone || '企业账号',
          // 不返回团队池余额：成员只需要知道「谁在付费 + 我今天用了多少 / 上限」，
          // 池子具体剩多少属于企业主的财务信息。余额不足时提示联系管理员即可。
          // 上限必须走三级回落（成员 → 团队默认 → 不限），与扣费侧同口径。
          dailyLimitPoints: memberLimits?.limitPoints ?? null,
          dailyLimitBeans: memberLimits?.limitBeans ?? null,
          // 跨天归零：昨天消费过、今天还没消费的成员，key 仍是昨天，必须判等而非真值
          spentTodayPoints: isTodayKey(me.teamSpentDay) ? me.teamSpentPoints : 0,
          spentTodayBeans: isTodayKey(me.teamSpentDay) ? me.teamSpentBeans : 0,
        }
      : null,
    /** 我作为「出资人」拥有的团队（null = 我不是 owner） */
    asOwner: ownedTeam
      ? {
          id: ownedTeam.id,
          name: ownedTeam.name,
          // 审核状态：未过审前成员无法添加、也不产生共享扣费（必须让老板看到为什么）
          status: ownedTeam.status,
          reviewNote: ownedTeam.reviewNote,
          reviewedAt: ownedTeam.reviewedAt?.toISOString() ?? null,
          defaultDailyLimit: ownedTeam.defaultDailyLimit,
          defaultDailyBeans: ownedTeam.defaultDailyBeans,
          poolPoints: me.points,
          poolBeans: me.beans,
          members: members.map((m) => ({
            id: m.id,
            name: m.nickname || m.phone || m.id,
            dailyLimit: m.teamDailyLimit,
            dailyBeans: m.teamDailyBeans,
            note: m.teamMemberNote,
            disabled: m.teamDisabled,
            spentTodayPoints: isTodayKey(m.teamSpentDay) ? m.teamSpentPoints : 0,
            spentTodayBeans: isTodayKey(m.teamSpentDay) ? m.teamSpentBeans : 0,
            joinedAt: m.createdAt.toISOString(),
          })),
        }
      : null,
    /** 我自己的余额（自付时用；团队模式下是 0，真实可用看 asMember.pool*） */
    selfPoints: me.points,
    selfBeans: me.beans,
  }
})

/** 创建/更新我的团队（我是 owner）。成员通过邀请码加入（见 ./members）。 */
export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown; defaultDailyLimit?: unknown; defaultDailyBeans?: unknown
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw new ApiHandlerError('请输入团队名称', 400)
  const defaultDailyLimit = typeof body.defaultDailyLimit === 'number' && body.defaultDailyLimit >= 0 ? body.defaultDailyLimit : 0
  const defaultDailyBeans = typeof body.defaultDailyBeans === 'number' && body.defaultDailyBeans >= 0 ? body.defaultDailyBeans : 0

  const team = await prisma.team.upsert({
    where: { ownerId: authUser.userId },
    create: { name, ownerId: authUser.userId, defaultDailyLimit, defaultDailyBeans },
    // 被驳回后重新保存 = 重新提交审核（回到 PENDING）；
    // 已通过的企业改个名字/额度**不**该重新排队（审核结果保留）。
    // 待审的保持待审（不要因为改个字就把队排到后面）。
    update: { name, defaultDailyLimit, defaultDailyBeans },
  })
  // 驳回后重新保存 = 重新提交审核。必须在 upsert 之后单独做：
  // upsert 的 update 分支不能带 status（否则「已通过」也会被改回 PENDING）。
  if (team.status === 'REJECTED') {
    await prisma.team.update({
      where: { id: team.id },
      data: { status: 'PENDING', reviewNote: null, reviewedBy: null, reviewedAt: null },
    })
    return success({ id: team.id, status: 'PENDING' }, '已重新提交审核，请等待管理员处理')
  }
  return success({ id: team.id, status: team.status }, team.status === 'APPROVED' ? '团队已保存' : '团队已保存，等待管理员审核后生效')
})
