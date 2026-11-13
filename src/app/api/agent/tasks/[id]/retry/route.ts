import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 重试失败任务：复用已完成子任务，只重跑失败的（简化为重置任务状态，前端重新 send）
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
    if (task.status !== 'FAILED') {
      throw new ApiHandlerError('仅失败的任务可重试', 400)
    }

    // 原子认领（Q-D06）：「读 FAILED 后无条件置 RUNNING」的窗口里双击/并发重试
    // 会重置两次 → 前端重发两次 = 两个任务双重扣费。条件写只有一方能抢到。
    // 注：本路由当前无前端调用方（面板用的是 resume/confirm/cancel），认领后若不重发
    // 会停留在 RUNNING —— 该语义待 Phase 2 决定（接线或下线），见台账 Q-D06。
    const claimed = await prisma.generationTask.updateMany({
      where: { id: task.id, userId: authUser.userId, status: 'FAILED' },
      data: { status: 'RUNNING', error: null },
    })
    if (claimed.count === 0) {
      throw new ApiHandlerError('任务状态已变化（可能已被重试或处理），请刷新后重试', 409)
    }

    const p = (task.payload as Record<string, unknown> | null) || {}
    return success(
      {
        id: task.id,
        status: 'RUNNING',
        retryPayload: {
          mode: p.mode || 'smart',
          prompt: p.prompt || '',
          images: p.images || [],
          params: p.params || {},
        },
      },
      '已重置，可重新发起'
    )
  }
)
