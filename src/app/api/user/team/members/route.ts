import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { notifyUser } from '@/lib/notify'

/**
 * 团队成员管理（仅 owner 可操作）。
 *
 * ⚠️ 加入/移除只改 `User.billingOwnerId` 这一个字段：
 *   - 成员自己的余额、历史流水、产出**全部保留不动**（不做资产迁移）
 *   - 加入前的历史流水 billingOwnerId=null（自付），清晰可辨，不会和团队账混在一起
 *   - 移除 = billingOwnerId 置 null → 立刻回到自付，不会继续花团队的钱
 *
 * 为什么不把成员余额「合并进团队池」：那是不可逆的资金操作，
 * 且成员可能有自己充的钱。保持两边账目独立、只改变「未来扣谁的钱」是最安全的语义。
 */

async function requireOwner(request: NextRequest) {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const team = await prisma.team.findUnique({ where: { ownerId: authUser.userId } })
  if (!team) throw new ApiHandlerError('你还没有创建团队', 400)
  // 未过审不允许加成员：否则会先攒一批成员，等审核时才发现是代充通道，
  // 且成员带着 billingOwnerId 空等（UI 显示在团队里、实际不共享）。
  if (team.status !== 'APPROVED') {
    throw new ApiHandlerError(
      team.status === 'PENDING'
        ? '团队正在等待管理员审核，通过后才能添加成员'
        : team.status === 'SUSPENDED'
          ? '团队已被平台停用，请联系管理员'
          : '团队未通过审核，无法添加成员',
      400,
    )
  }
  return { authUser, prisma, team }
}

/** 按手机号/邮箱把用户加进团队 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { authUser, prisma, team } = await requireOwner(request)
  const body = (await request.json().catch(() => ({}))) as { phone?: unknown; email?: unknown; dailyLimit?: unknown; dailyBeans?: unknown; note?: unknown }
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!phone && !email) throw new ApiHandlerError('请输入成员的手机号或邮箱', 400)

  const member = await prisma.user.findFirst({
    where: phone ? { phone } : { email },
    select: { id: true, nickname: true, phone: true, billingOwnerId: true },
  })
  if (!member) throw new ApiHandlerError('未找到该用户（对方需先在本站注册）', 404)
  if (member.id === authUser.userId) throw new ApiHandlerError('不能把自己加为成员', 400)
  if (member.billingOwnerId === authUser.userId) throw new ApiHandlerError('该成员已在团队中', 400)
  // 一个人只能属于一个团队：已在别的团队时必须先退出，否则会「两头扣钱」不可预测
  if (member.billingOwnerId && member.billingOwnerId !== authUser.userId) {
    throw new ApiHandlerError('该用户已属于其他团队，请先在原团队中移除', 400)
  }

  const dailyLimit = typeof body.dailyLimit === 'number' && body.dailyLimit >= 0 ? body.dailyLimit : null
  const dailyBeans = typeof body.dailyBeans === 'number' && body.dailyBeans >= 0 ? body.dailyBeans : null
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 60) || null : null
  await prisma.user.update({
    where: { id: member.id },
    data: {
      billingOwnerId: authUser.userId,
      teamDailyLimit: dailyLimit,
      teamDailyBeans: dailyBeans,
      teamMemberNote: note,
      teamDisabled: false,
      // 加入即重置今日用量：否则会把「加入前的自付用量」算进团队额度
      teamSpentDay: null, teamSpentPoints: 0, teamSpentBeans: 0,
    },
  })
  // 被加入团队 = 他的消费开始花别人的钱，必须让本人知道（否则会以为账号被入侵）
  void notifyUser({
    userId: member.id,
    kind: 'team_member',
    title: `你已加入企业团队「${team.name}」`,
    content: `团队管理员已将你加入团队，你的生成消费将从团队账户扣除，不再使用你自己的余额。\n你自己的余额仍然保留，退出团队或团队停用后恢复使用。`,
    link: '/user/profile',
  })
  void team
  return success({ id: member.id }, '已加入团队')
})

/** 调整成员额度 / 移除成员 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { authUser, prisma } = await requireOwner(request)
  const body = (await request.json().catch(() => ({}))) as {
    memberId?: unknown; dailyLimit?: unknown; dailyBeans?: unknown
    disabled?: unknown; note?: unknown; remove?: unknown
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId : ''
  if (!memberId) throw new ApiHandlerError('缺少成员 ID', 400)

  const member = await prisma.user.findFirst({
    where: { id: memberId, billingOwnerId: authUser.userId },
    select: { id: true },
  })
  if (!member) throw new ApiHandlerError('该用户不在你的团队中', 404)

  if (body.remove === true) {
    // 移除 = 回到自付。只改归属，不动任何余额/流水。
    await prisma.user.update({
      where: { id: memberId },
      data: {
        billingOwnerId: null, teamDailyLimit: null, teamDailyBeans: null,
        teamMemberNote: null, teamDisabled: false,
        teamSpentDay: null, teamSpentPoints: 0, teamSpentBeans: 0,
      },
    })
    // 被移出 = 明天开始花自己的钱；不通知的话下一次生成会突然「余额不足」像故障
    const team = await prisma.team.findUnique({ where: { ownerId: authUser.userId }, select: { name: true } })
    void notifyUser({
      userId: memberId,
      kind: 'team_member',
      title: `你已被移出企业团队「${team?.name || '企业团队'}」`,
      content: '团队管理员已将你移出团队，你的生成消费回退为使用自己的余额。如有疑问请联系团队管理员。',
      link: '/user/profile',
    })
    return success({ id: memberId }, '已移出团队，该成员恢复为自付')
  }

  // 部分更新：只改请求里带的字段，避免「改额度时把备注/停用状态冲掉」。
  // 分不开的话前端每改一项就得把全量字段一起回传，容易漏字段造成静默丢失。
  const data: Record<string, unknown> = {}
  if ('dailyLimit' in body) data.teamDailyLimit = typeof body.dailyLimit === 'number' && body.dailyLimit >= 0 ? body.dailyLimit : null
  if ('dailyBeans' in body) data.teamDailyBeans = typeof body.dailyBeans === 'number' && body.dailyBeans >= 0 ? body.dailyBeans : null
  if ('disabled' in body) data.teamDisabled = body.disabled === true
  if ('note' in body) data.teamMemberNote = typeof body.note === 'string' ? body.note.trim().slice(0, 60) || null : null
  if (Object.keys(data).length === 0) throw new ApiHandlerError('没有要更新的字段', 400)

  await prisma.user.update({ where: { id: memberId }, data })
  // 停用/启用会直接改变扣费来源，必须通知（否则成员会以为「公司不给我付了」）
  if ('disabled' in data) {
    const team = await prisma.team.findUnique({ where: { ownerId: authUser.userId }, select: { name: true } })
    const disabled = data.teamDisabled === true
    void notifyUser({
      userId: memberId,
      kind: 'team_member',
      title: disabled
        ? `你在企业团队「${team?.name || ''}」的团队计费已被停用`
        : `你在企业团队「${team?.name || ''}」的团队计费已恢复`,
      content: disabled
        ? '团队管理员已暂停为你承担消费，你的生成将使用自己的余额。'
        : '团队管理员已恢复你的团队计费，生成消费重新从团队账户扣除。',
      link: '/user/profile',
    })
  }
  return success({ id: memberId }, '成员信息已更新')
})
