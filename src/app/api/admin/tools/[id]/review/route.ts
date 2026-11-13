import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { adjustPoints } from '@/lib/billing/wallet'
import { writeAdminAction } from '@/lib/admin-audit'

type Ctx = { params: Promise<{ id: string }> }

const ALLOWED_STATUS = ['PENDING', 'APPROVED', 'REJECTED']

// 管理员工具审核：通过(发 20~1000 积分) / 驳回 / 封为官方(发最多 10000 积分)，金额管理员手输
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params
    const body = await request.json() as { action?: string; points?: unknown; makeOfficial?: boolean }
    const action = body.action
    if (action !== 'approve' && action !== 'reject' && action !== 'official') {
      throw new ApiHandlerError('无效操作', 400)
    }

    const prisma = await getPrisma()
    const tool = await prisma.tool.findUnique({ where: { id } })
    if (!tool) throw new ApiHandlerError('工具不存在', 404)

    // 积分奖励：审核通过 20~1000，封为官方 1~10000，管理员手输
    // 必须显式拒非法值：Number('abc')=NaN 会让下面所有比较都为 false（NaN>x / NaN<0 均不成立），
    // 于是 NaN 一路传到 adjustPoints，被 roundPoints 归 0 → 静默不发奖励，管理员以为发过了。
    const rawPoints = body.points == null || body.points === '' ? 0 : Number(body.points)
    if (!Number.isFinite(rawPoints)) throw new ApiHandlerError('奖励积分必须是数字', 400)
    let points = Math.floor(rawPoints)
    if (action === 'approve' && points > 1000) throw new ApiHandlerError('审核通过奖励最高 1000 积分', 400)
    if (action === 'official' && points > 10000) throw new ApiHandlerError('封为官方奖励最高 10000 积分', 400)
    if (points < 0) points = 0

    const data =
      action === 'approve'
        ? { status: 'APPROVED' as const, isOfficial: tool.isOfficial }
        : action === 'reject'
          ? { status: 'REJECTED' as const }
          : { status: 'APPROVED' as const, isOfficial: true }

    // 状态变更、作者奖励、管理留痕必须**同一事务**（Q-D42）。
    // 此前这里是「先 update 状态、再 adjustPoints 发奖励」两步分提交：
    // 中间任何一次失败（余额校验抛错、进程被重启）都会留下
    // 「工具已审核通过，但作者答应得的奖励没发出去」的哑账 —— 作者不会知道自己少拿了，
    // 管理员看到的就是「审核成功」，两边都对不上账。
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.tool.update({ where: { id }, data })
      if (points > 0) {
        await adjustPoints(
          tool.authorId,
          points,
          `工具${action === 'official' ? '被收录为官方' : '审核通过'}奖励：${tool.name}`,
          tx,
        )
      }
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: tool.authorId,
        action: `tool_${action}`,
        note: `管理员${action === 'reject' ? '驳回' : action === 'official' ? '收录为官方' : '通过'}工具「${tool.name}」${points > 0 ? `，奖励作者 ${points} 积分` : '（未发奖励）'}`,
      })
      return row
    })

    const msg =
      action === 'official'
        ? `已封为官方${points > 0 ? `，奖励作者 ${points} 积分` : ''}`
        : action === 'approve'
          ? `已通过${points > 0 ? `，奖励作者 ${points} 积分` : ''}`
          : '已驳回'
    return success({ id: updated.id, status: updated.status, isOfficial: updated.isOfficial }, msg)
  }
)

// 管理员编辑工具：名称/描述/分类/上下架（status 直接改）
export const PATCH = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params
    const body = await request.json() as {
      name?: string; description?: string; category?: string
      status?: string; isOfficial?: boolean; coverUrl?: string | null
    }
    if (body.status && !ALLOWED_STATUS.includes(body.status)) {
      throw new ApiHandlerError('无效状态', 400)
    }
    const prisma = await getPrisma()
    const tool = await prisma.tool.findUnique({ where: { id } })
    if (!tool) throw new ApiHandlerError('工具不存在', 404)

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) { if (!body.name.trim()) throw new ApiHandlerError('名称不能为空', 400); data.name = body.name.trim() }
    if (body.description !== undefined) data.description = body.description
    if (body.category !== undefined) data.category = body.category
    if (body.status !== undefined) data.status = body.status
    if (body.isOfficial !== undefined) data.isOfficial = body.isOfficial
    // 封面：管理员在「编辑」里上传工具预览图（4:3）。传空字符串表示清除封面。
    if (body.coverUrl !== undefined) {
      data.coverUrl = typeof body.coverUrl === 'string' && body.coverUrl.trim() ? body.coverUrl.trim() : null
    }
    if (Object.keys(data).length === 0) throw new ApiHandlerError('没有要修改的字段', 400)

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.tool.update({ where: { id }, data })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: tool.authorId,
        action: 'tool_update',
        // 上下架（status）会直接改变对外可见性，必须留下改前→改后
        note: `管理员编辑工具「${tool.name}」：${JSON.stringify(data)}（改前 status=${tool.status}）`,
      })
      return row
    })
    return success({ id: updated.id, status: updated.status, isOfficial: updated.isOfficial }, '已保存')
  }
)
