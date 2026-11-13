import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'

// 查询画布执行任务状态 + 输出快照
export const GET = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const run = await prisma.canvasRun.findFirst({
      where: { id, userId: authUser.userId },
    })
    if (!run) {
      throw new ApiHandlerError('执行任务不存在', 404)
    }

    return {
      id: run.id,
      status: run.status,
      workflowName: run.workflowName,
      error: run.error,
      costPoints: run.costPoints,
      costBeans: run.costBeans,
      seedOutputs: run.seedOutputs,
      executedNodeIds: run.executedNodeIds,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    }
  }
)
