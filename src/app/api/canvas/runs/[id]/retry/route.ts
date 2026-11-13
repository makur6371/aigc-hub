import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 重试失败/取消的画布任务：重置为 PENDING，返回 runId 供前端重新执行
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const run = await prisma.canvasRun.findFirst({ where: { id, userId: authUser.userId } })
    if (!run) {
      throw new ApiHandlerError('执行任务不存在', 404)
    }
    if (run.status !== 'FAILED' && run.status !== 'CANCELLED') {
      throw new ApiHandlerError('仅失败或取消的任务可重试', 400)
    }

    const updated = await prisma.canvasRun.update({
      where: { id },
      data: { status: 'RUNNING', error: null },
    })

    return success(
      {
        id,
        status: updated.status,
        nodes: run.nodes,
        connections: run.connections,
        seedOutputs: run.seedOutputs,
        executedNodeIds: run.executedNodeIds,
      },
      '已重置，可重新执行'
    )
  }
)
