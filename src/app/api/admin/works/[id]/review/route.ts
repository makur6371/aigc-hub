import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { adjustPoints } from '@/lib/billing/wallet'
import { writeAdminAction } from '@/lib/admin-audit'

// 后台作品审核：通过(发 20~1000 积分) / 驳回 / 封为官方作品(最多 10000 积分)，金额管理员手输
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })

    const { id } = await params
    const body = await request.json() as { action?: string; points?: unknown }
    const action = body.action
    if (action !== 'approve' && action !== 'reject' && action !== 'official') {
      throw new ApiHandlerError('无效操作', 400)
    }

    const prisma = await getPrisma()
    const work = await prisma.sharedWork.findUnique({ where: { id } })
    if (!work) {
      throw new ApiHandlerError('作品不存在', 404)
    }

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
        ? { status: 'APPROVED' as const }
        : action === 'reject'
          ? { status: 'REJECTED' as const }
          : { status: 'APPROVED' as const, featured: true } // 封官方作品=置顶精选展示

    // 与工具审核同口径（Q-D42）：状态变更 + 作者奖励 + 留痕同一事务，
    // 避免「作品已通过但作者没拿到奖励」这类双方都不知情的哑账。
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.sharedWork.update({ where: { id }, data })
      if (points > 0) {
        await adjustPoints(
          work.authorId,
          points,
          `作品${action === 'official' ? '被收录为官方精选' : '审核通过'}奖励：${work.title}`,
          tx,
        )
      }
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: work.authorId,
        action: `work_${action}`,
        note: `管理员${action === 'reject' ? '驳回' : action === 'official' ? '收录为官方精选' : '通过'}作品「${work.title}」${points > 0 ? `，奖励作者 ${points} 积分` : '（未发奖励）'}`,
      })
      return row
    })

    const msg =
      action === 'official'
        ? `已封为官方作品${points > 0 ? `，奖励作者 ${points} 积分` : ''}`
        : action === 'approve'
          ? `已通过${points > 0 ? `，奖励作者 ${points} 积分` : ''}`
          : '已驳回'
    return success({ id: updated.id, status: updated.status, featured: updated.featured }, msg)
  }
)
