import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { notifyUser, notifyUsers } from '@/lib/notify'
import { writeAdminAction } from '@/lib/admin-audit'

/**
 * 后台：审核企业团队（通过 / 驳回）。
 *
 * 通过 = 该团队的成员消费开始从 owner 余额扣；
 * 驳回/打回待审 = 立刻停止共享（扣费解析层读的就是这个 status，无需成员做任何事）。
 *
 * 为什么驳回时要**同时解除成员归属**：只改 status 已经能让扣费回退自付，
 * 但成员身上还挂着 billingOwnerId，UI 会显示「我在某团队」而实际不共享 ——
 * 状态自相矛盾。这里一并清掉，让数据与行为一致（成员回到干净的独立账号）。
 */
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; note?: unknown }
    const action = body.action
    if (action !== 'approve' && action !== 'reject' && action !== 'suspend' && action !== 'resume') {
      throw new ApiHandlerError('无效操作', 400)
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : null

    const prisma = await getPrisma()
    const team = await prisma.team.findUnique({ where: { id } })
    if (!team) throw new ApiHandlerError('团队不存在', 404)

    if (action === 'approve') {
      // 状态与留痕同事务（Q-D42）：通过即开启「成员消费从老板余额扣」，
      // 这一步是谁按下的必须和状态一起落库；分成两次提交时，
      // 留痕失败会给管理员一个 500，他会以为没通过而再审一次。
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.team.update({
          where: { id },
          data: { status: 'APPROVED', reviewNote: note, reviewedBy: admin.userId, reviewedAt: new Date() },
        })
        await writeAdminAction(tx, {
          adminId: admin.userId,
          userId: team.ownerId,
          action: 'team_approve',
          note: `企业团队「${team.name}」审核通过${note ? `：${note}` : ''}`,
        })
        return row
      })
      // 申请人必须知道「什么时候开始生效的」——否则他会一直等一个已经在跑的功能
      void notifyUser({
        userId: team.ownerId,
        kind: 'team_review',
        title: `企业团队「${team.name}」已通过审核`,
        content: `管理员的审核已通过，团队共享计费已生效：成员的生成消费将从你的余额扣除。${note ? `\n审核说明：${note}` : ''}`,
        link: '/user/profile',
      })
      return success({ id: updated.id, status: updated.status }, '已通过，团队共享计费生效')
    }

    // 停用 / 恢复：与企业主「停用成员」同源思路 —— 停用**保留成员名册**，
    // 只让扣费回退自付（闸门读的是 status!=='APPROVED'）。
    // 与「驳回」的区别：驳回是「申请没通过」，会解除成员绑定；
    // 停用是「已通过的企业暂时冻结」，成员名册原样保留，恢复后立即可用。
    if (action === 'suspend' || action === 'resume') {
      // 停用复用 SUSPENDED（不复用 REJECTED —— 那是「申请被拒」的语义，不该混）
      const nextStatus = action === 'suspend' ? 'SUSPENDED' : 'APPROVED'
      // 与 approve 同理：停用/恢复**立刻改变扣费行为**，状态与留痕同事务。
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.team.update({
          where: { id },
          data: { status: nextStatus, reviewNote: note, reviewedBy: admin.userId, reviewedAt: new Date() },
        })
        await writeAdminAction(tx, {
          adminId: admin.userId,
          userId: team.ownerId,
          action: action === 'suspend' ? 'team_suspend' : 'team_resume',
          note: `企业团队「${team.name}」${action === 'suspend' ? '被停用（成员立即停止共享计费）' : '已恢复'}${note ? `：${note}` : ''}`,
        })
        return row
      })
      // 停用会立刻改变扣费行为（成员突然变成自付），老板与成员都要知道，否则会当成 bug
      const memberIds = action === 'suspend'
        ? (await prisma.user.findMany({ where: { billingOwnerId: team.ownerId }, select: { id: true } })).map((m) => m.id)
        : []
      void notifyUsers([
        {
          userId: team.ownerId,
          kind: 'team_review',
          title: `企业团队「${team.name}」${action === 'suspend' ? '已被停用' : '已恢复'}`,
          content: action === 'suspend'
            ? `平台已停用该团队的共享计费，成员的消费将回退为各自承担。${note ? `\n说明：${note}` : ''}\n如需申诉请联系管理员。`
            : `该团队已恢复，成员的生成消费重新从你的余额扣除。${note ? `\n说明：${note}` : ''}`,
          link: '/user/profile',
        },
        ...memberIds.map((uid) => ({
          userId: uid,
          kind: 'team_member' as const,
          title: `企业团队「${team.name}」已暂停共享计费`,
          content: '团队的共享计费已被平台暂停，你的生成消费暂时回退为使用自己的余额。如有疑问请联系团队管理员。',
          link: '/user/profile',
        })),
      ])
      return success({ id: updated.id, status: updated.status }, action === 'suspend' ? '已停用，团队共享计费已停止' : '已恢复，共享计费重新生效')
    }

    // 驳回：状态置 REJECTED 并**解除全部成员归属**（数据与行为一致）
    const rejectedMembers = await prisma.user.findMany({
      where: { billingOwnerId: team.ownerId },
      select: { id: true },
    })
    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.team.update({
        where: { id },
        data: { status: 'REJECTED', reviewNote: note, reviewedBy: admin.userId, reviewedAt: new Date() },
      })
      await tx.user.updateMany({
        where: { billingOwnerId: team.ownerId },
        data: {
          billingOwnerId: null, teamDailyLimit: null, teamDailyBeans: null,
          teamMemberNote: null, teamDisabled: false,
          teamSpentDay: null, teamSpentPoints: 0, teamSpentBeans: 0,
        },
      })
      // 留痕挪进事务内（原先在 $transaction 之外）：驳回会**批量解绑成员**，
      // 解绑已提交而留痕失败时返回 500，管理员重试就是第二次解绑全团队。
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: team.ownerId,
        action: 'team_reject',
        note: `企业团队「${team.name}」被驳回${note ? `：${note}` : ''}`,
      })
      return t
    })
    // 驳回**同时解绑了成员**——成员不通知就会「一觉醒来发现自己不在团队里了」
    void notifyUsers([
      {
        userId: team.ownerId,
        kind: 'team_review',
        title: `企业团队「${team.name}」审核未通过`,
        content: `申请未通过，团队成员已解除绑定。${note ? `\n原因：${note}` : ''}\n修改团队信息后重新保存即可再次提交审核。`,
        link: '/user/profile',
      },
      ...rejectedMembers.map((m) => ({
        userId: m.id,
        kind: 'team_member' as const,
        title: `你所属的企业团队「${team.name}」审核未通过`,
        content: '该团队的申请未通过审核，你已被移出团队，生成消费回退为使用自己的余额。如有疑问请联系团队管理员。',
        link: '/user/profile',
      })),
    ])
    return success({ id: updated.id, status: updated.status }, '已驳回，团队成员已解除绑定')
  }
)
