import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'

// 查询任务状态 + result + subtasks
export const GET = apiHandler<{ id: string }>(
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

    return {
      id: task.id,
      status: task.status,
      taskType: task.taskType,
      payload: task.payload,
      result: task.result,
      error: task.error,
      costPoints: task.costPoints,
      costBeans: task.costBeans,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }
  }
)
