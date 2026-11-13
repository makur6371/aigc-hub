import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { isTodayKey } from '@/lib/day-key'
import { recordAdminAction } from '@/lib/admin-audit'

/**
 * 后台：单个企业团队详情 —— 成员名册 + 团队设置。
 *
 * 为什么管理员需要这一层（而不只是审核）：审核通过后企业仍会出问题 ——
 * 成员跑了异常任务、企业主要求平台协助停人、要核对「这个团队到底有谁」。
 * 只有审核入口的话，管理员无法处理这些，只能让企业主自己去操作。
 */
export const GET = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  await requireAuth(request, { admin: true })
  const { id } = await params
  const prisma = await getPrisma()

  const team = await prisma.team.findUnique({
    where: { id },
    include: { owner: { select: { id: true, nickname: true, phone: true, email: true, points: true, beans: true, status: true, createdAt: true } } },
  })
  if (!team) throw new ApiHandlerError('团队不存在', 404)

  const members = await prisma.user.findMany({
    where: { billingOwnerId: team.ownerId },
    select: {
      id: true, nickname: true, phone: true, email: true, status: true,
      teamDailyLimit: true, teamDailyBeans: true, teamMemberNote: true, teamDisabled: true,
      teamSpentDay: true, teamSpentPoints: true, teamSpentBeans: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  // 每个成员的累计团队消费（净额口径见 /api/user/team/spending 的说明）
  const spends = await prisma.pointsLog.groupBy({
    by: ['userId'],
    where: { billingOwnerId: team.ownerId, type: 'DEDUCTION' },
    _sum: { amount: true },
    _count: true,
  })
  const spendMap = new Map(spends.map((s) => [s.userId, { points: Math.abs(s._sum.amount ?? 0), calls: s._count }]))

  return {
    id: team.id,
    name: team.name,
    status: team.status,
    reviewNote: team.reviewNote,
    reviewedAt: team.reviewedAt?.toISOString() ?? null,
    createdAt: team.createdAt.toISOString(),
    defaultDailyLimit: team.defaultDailyLimit,
    defaultDailyBeans: team.defaultDailyBeans,
    owner: {
      id: team.owner.id,
      name: team.owner.nickname || team.owner.phone || team.owner.email || team.owner.id,
      phone: team.owner.phone, email: team.owner.email,
      points: team.owner.points, beans: team.owner.beans,
      status: team.owner.status,
      registeredAt: team.owner.createdAt.toISOString(),
    },
    members: members.map((m) => {
      const s = spendMap.get(m.id)
      return {
        id: m.id,
        name: m.nickname || m.phone || m.email || m.id,
        phone: m.phone, email: m.email,
        accountStatus: m.status,
        dailyLimit: m.teamDailyLimit,
        dailyBeans: m.teamDailyBeans,
        note: m.teamMemberNote,
        disabled: m.teamDisabled,
        spentTodayPoints: isTodayKey(m.teamSpentDay) ? m.teamSpentPoints : 0,
        spentTodayBeans: isTodayKey(m.teamSpentDay) ? m.teamSpentBeans : 0,
        totalSpentPoints: s?.points ?? 0,
        totalCalls: s?.calls ?? 0,
        joinedAt: m.createdAt.toISOString(),
      }
    }),
  }
})

/**
 * 后台代企业主调整团队设置（额度 / 是否允许成员自助充值）。
 * 管理员介入场景：企业主不会用、或团队已被打回需要平台协助。
 */
export const PATCH = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  const admin = await requireAuth(request, { admin: true })
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown; memberId?: unknown; dailyLimit?: unknown; dailyBeans?: unknown
    disabled?: unknown; note?: unknown; name?: unknown; defaultDailyLimit?: unknown; defaultDailyBeans?: unknown
  }
  const prisma = await getPrisma()
  const team = await prisma.team.findUnique({ where: { id } })
  if (!team) throw new ApiHandlerError('团队不存在', 404)

  // ===== 成员级操作（管理员代管：踢人 / 停用 / 改额度） =====
  if (body.action === 'updateMember' || body.action === 'removeMember') {
    const memberId = typeof body.memberId === 'string' ? body.memberId : ''
    if (!memberId) throw new ApiHandlerError('缺少成员 ID', 400)
    const member = await prisma.user.findFirst({
      where: { id: memberId, billingOwnerId: team.ownerId },
      select: { id: true },
    })
    if (!member) throw new ApiHandlerError('该用户不在此团队中', 404)

    if (body.action === 'removeMember') {
      await prisma.user.update({
        where: { id: memberId },
        data: {
          billingOwnerId: null, teamDailyLimit: null, teamDailyBeans: null,
          teamMemberNote: null, teamDisabled: false,
          teamSpentDay: null, teamSpentPoints: 0, teamSpentBeans: 0,
        },
      })
      // 这三处用 `recordAdminAction`（永不抛错）而非事务版：业务写已在前一行单独提交，
      // 留痕若抛错会给管理员一个 500，他以为「踢人没成功」而再点一次 ——
      // 留痕失败不该制造比留痕缺失更大的事故。缺行风险由错误面板兜住（scope=admin-audit）。
      await recordAdminAction({
        adminId: admin.userId,
        userId: memberId,
        action: 'team_member_remove',
        note: `管理员将成员移出企业团队「${team.name}」`,
      })
      return success({ id: memberId }, '已将该成员移出团队')
    }

    const data: Record<string, unknown> = {}
    if ('dailyLimit' in body) data.teamDailyLimit = typeof body.dailyLimit === 'number' && body.dailyLimit >= 0 ? body.dailyLimit : null
    if ('dailyBeans' in body) data.teamDailyBeans = typeof body.dailyBeans === 'number' && body.dailyBeans >= 0 ? body.dailyBeans : null
    if ('disabled' in body) data.teamDisabled = body.disabled === true
    if ('note' in body) data.teamMemberNote = typeof body.note === 'string' ? body.note.trim().slice(0, 60) || null : null
    if (Object.keys(data).length === 0) throw new ApiHandlerError('没有要更新的字段', 400)
    await prisma.user.update({ where: { id: memberId }, data })
    await recordAdminAction({
      adminId: admin.userId,
      userId: memberId,
      action: 'team_member_update',
      note: `管理员调整了企业团队「${team.name}」的成员设置：${JSON.stringify(data)}`,
    })
    return success({ id: memberId }, '成员设置已更新')
  }

  // ===== 团队级设置 =====
  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 30)
  if ('defaultDailyLimit' in body) data.defaultDailyLimit = typeof body.defaultDailyLimit === 'number' && body.defaultDailyLimit >= 0 ? body.defaultDailyLimit : 0
  if ('defaultDailyBeans' in body) data.defaultDailyBeans = typeof body.defaultDailyBeans === 'number' && body.defaultDailyBeans >= 0 ? body.defaultDailyBeans : 0
  if (Object.keys(data).length === 0) throw new ApiHandlerError('没有要更新的字段', 400)

  const updated = await prisma.team.update({ where: { id }, data })
  await recordAdminAction({
    adminId: admin.userId,
    userId: team.ownerId,
    action: 'team_update',
    note: `管理员调整企业团队「${team.name}」设置：${JSON.stringify(data)}`,
  })
  return success({ id: updated.id }, '团队设置已更新')
})
