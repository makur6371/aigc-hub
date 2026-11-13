import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 暂停画布执行
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const run = await prisma.canvasRun.findFirst({ where: { id, userId: authUser.userId } })
    if (!run) {
      throw new ApiHandlerError('执行任务不存在', 404)
    }
    if (run.status !== 'RUNNING' && run.status !== 'PENDING') {
      throw new ApiHandlerError('仅运行中的任务可暂停', 400)
    }

    const updated = await prisma.canvasRun.update({ where: { id }, data: { status: 'PAUSED' } })
    return success({ id, status: updated.status }, '已暂停')
  }
)
