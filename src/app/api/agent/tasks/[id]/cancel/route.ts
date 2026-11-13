import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 取消任务
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const task = await prisma.generationTask.findFirst({
      where: { id, userId: authUser.userId },
    })
    if (!task) {
      throw new ApiHandlerError('任务不存在', 404)
    }

    if (!['PENDING', 'RUNNING', 'PAUSED', 'REVISING'].includes(task.status)) {
      throw new ApiHandlerError('任务已结束，无需取消', 409)
    }

    // 条件更新：并发点击/任务刚好完成时，不把 SUCCEEDED 覆盖成 CANCELLED。
    const updated = await prisma.generationTask.updateMany({
      where: { id: task.id, userId: authUser.userId, status: { in: ['PENDING', 'RUNNING', 'PAUSED', 'REVISING'] } },
      data: { status: 'CANCELLED' },
    })
    if (updated.count === 0) {
      const latest = await prisma.generationTask.findUnique({ where: { id: task.id }, select: { status: true } })
      return success({ id: task.id, status: latest?.status || 'UNKNOWN' }, '任务已结束')
    }

    return success({ id: task.id, status: 'CANCELLED' }, '已取消')
  }
)
