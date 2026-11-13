import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 恢复画布执行（PAUSED → RUNNING；前端重新发起增量执行，跳过已完成节点）
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const run = await prisma.canvasRun.findFirst({ where: { id, userId: authUser.userId } })
    if (!run) {
      throw new ApiHandlerError('执行任务不存在', 404)
    }
    if (run.status !== 'PAUSED') {
      throw new ApiHandlerError('仅暂停的任务可恢复', 400)
    }

    const updated = await prisma.canvasRun.update({ where: { id }, data: { status: 'RUNNING' } })
    return success(
      {
        id,
        status: updated.status,
        seedOutputs: run.seedOutputs,
        executedNodeIds: run.executedNodeIds,
      },
      '已恢复，可继续执行'
    )
  }
)
