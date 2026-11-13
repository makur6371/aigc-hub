import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { collectSubtaskMedia, patchAssistantTaskMessage } from '@/lib/chat-persistence'
import {
  isAgentCheckpointExpired,
  parseAgentCheckpoint,
  type AgentCheckpoint,
} from '@/lib/agent-checkpoint'
import type { PrismaClient } from '@prisma/client'

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v))

export const dynamic = 'force-dynamic'

/**
 * 从 durable checkpoint 恢复失败/中断的 Agent 任务。
 *
 * 恢复沿用原 taskId、clientRequestId 和已完成轮次，不新建购买/执行任务；
 * 已完成的动作和素材编号直接来自 GenerationTask.payload.agentCheckpoint。
 */
export const POST = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  const authUser = await requireAuth(request)
  const { id } = await params
  const prisma = await getPrisma()

  const task = await prisma.generationTask.findFirst({
    where: { id, userId: authUser.userId },
  })
  if (!task) throw new ApiHandlerError('任务不存在', 404)
  if (task.status !== 'FAILED') {
    throw new ApiHandlerError('仅失败或已中断的任务可从检查点继续', 409)
  }

  const payload = (task.payload as Record<string, unknown> | null) || {}
  if (payload.mode !== 'smart') {
    throw new ApiHandlerError('仅智能模式支持断点恢复', 400)
  }
  const checkpoint = parseAgentCheckpoint(payload.agentCheckpoint, {
    taskId: id,
    userId: authUser.userId,
  })
  if (!checkpoint) {
    throw new ApiHandlerError('该任务没有可用检查点，请重新发起', 409)
  }
  // 传库内更新时间兜底：检查点自带的时间戳不可信（未来时间可让 TTL 永不到期）
  if (isAgentCheckpointExpired(checkpoint, Date.now(), task.updatedAt)) {
    throw new ApiHandlerError('该任务检查点已过期，请重新发起', 409)
  }
  if (checkpoint.finished) {
    throw new ApiHandlerError('该任务已完成，无需继续', 409)
  }

  // 原子认领：双击/并发恢复只能有一方真正执行。
  const claimed = await prisma.generationTask.updateMany({
    where: { id, userId: authUser.userId, status: 'FAILED' },
    data: { status: 'RUNNING', error: null },
  })
  if (claimed.count === 0) {
    throw new ApiHandlerError('该任务已被处理', 409)
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let latestCheckpoint: AgentCheckpoint = checkpoint
      const emit = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch { /* 客户端已断开 */ }
      }
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { /* closed */ }
      }, 15000)

      const persistCheckpoint = async (next: AgentCheckpoint) => {
        latestCheckpoint = next
        const current = await prisma.generationTask.findUnique({
          where: { id },
          select: { payload: true },
        })
        const prev = (current?.payload as Record<string, unknown> | null) || payload
        await prisma.generationTask.update({
          where: { id },
          data: {
            payload: toJson({
              ...prev,
              agentCheckpoint: next,
              agentTrace: next.agentTrace,
            }),
          },
        })
      }

      try {
        emit({ type: 'task', taskId: id, mode: 'smart', sessionId: task.sessionId || null })
        const { runAgent } = await import('@/lib/agent-executor')
        const result = await runAgent({
          emit,
          userId: authUser.userId,
          prompt: String(payload.prompt || ''),
          images: Array.isArray(payload.images) ? payload.images.filter((x): x is string => typeof x === 'string') : undefined,
          sessionId: task.sessionId || null,
          taskId: id,
          params: (payload.params as Record<string, unknown> | undefined) || {},
          skillIds: Array.isArray(payload.skillIds) ? payload.skillIds.filter((x): x is string => typeof x === 'string') : undefined,
          checkpoint,
          onCheckpoint: persistCheckpoint,
        })
        latestCheckpoint = result.checkpoint || latestCheckpoint

        const current = await prisma.generationTask.findUnique({
          where: { id },
          select: { status: true, payload: true },
        })
        if (current?.status === 'CANCELLED') {
          emit({ type: 'cancelled', taskId: id, subtasks: result.subtasks })
          return
        }

        const prev = (current?.payload as Record<string, unknown> | null) || payload
        const awaitingConfirm = Boolean(result.pendingActions?.length)
        await prisma.generationTask.update({
          where: { id },
          data: {
            status: awaitingConfirm ? 'PAUSED' : 'SUCCEEDED',
            costPoints: result.totalCost,
            costBeans: result.totalBeans,
            result: toJson(awaitingConfirm
              ? { done: false, awaitingConfirm: true }
              : { done: true, resumed: true }),
            payload: toJson({
              ...prev,
              subtasks: result.subtasks,
              agentTrace: result.agentTrace || latestCheckpoint.agentTrace,
              agentCheckpoint: latestCheckpoint,
              ...(result.pendingActions?.length ? { pendingActions: result.pendingActions } : {}),
            }),
          },
        })

        await writeAssistantResult(prisma, {
          taskId: id,
          sessionId: task.sessionId || null,
          reply: result.reply,
          subtasks: result.subtasks,
          decisions: result.decisions,
          askQuestions: result.askQuestions,
          pendingActions: result.pendingActions,
        })

        emit({
          type: 'agentReply',
          reply: result.reply,
          decisions: result.decisions,
          askQuestions: result.askQuestions,
        })
        if (result.pendingActions?.length) {
          emit({
            type: 'awaitingConfirm',
            taskId: id,
            pendingActions: result.pendingActions,
            subtasks: result.subtasks,
            costPoints: result.totalCost,
            costBeans: result.totalBeans,
          })
        } else {
          emit({
            type: 'done',
            taskId: id,
            subtasks: result.subtasks,
            costPoints: result.totalCost,
            costBeans: result.totalBeans,
          })
        }
      } catch (err) {
        // 条件写（Q-D05）：恢复执行期间用户取消时保留 CANCELLED，不覆盖成 FAILED
        const failedWrite = await prisma.generationTask.updateMany({
          where: { id, status: { notIn: ['CANCELLED'] } },
          data: {
            status: 'FAILED',
            error: err instanceof Error ? err.message : '恢复执行失败',
            payload: toJson({
              ...payload,
              agentCheckpoint: latestCheckpoint,
              agentTrace: latestCheckpoint.agentTrace,
            }),
          },
        }).catch(() => null)
        if (failedWrite && failedWrite.count === 0) {
          emit({ type: 'cancelled', taskId: id, subtasks: [] })
          return
        }
        const message = err instanceof Error ? err.message : '恢复执行失败'
        emit({ type: 'error', message })
      } finally {
        clearInterval(heartbeat)
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

async function writeAssistantResult(
  prisma: PrismaClient,
  input: {
    taskId: string
    sessionId: string | null
    reply: string
    subtasks: Record<string, unknown>[]
    decisions: { label: string; value: string; reason: string }[]
    askQuestions?: unknown[]
    pendingActions?: unknown[]
  },
) {
  if (!input.sessionId) return
  const media = collectSubtaskMedia(input.subtasks)
  const taskMeta = {
    taskId: input.taskId,
    mode: 'smart',
    decisions: input.decisions,
    askQuestions: input.askQuestions || [],
    subtasks: input.subtasks,
    resumed: true,
    ...(input.pendingActions?.length ? { pendingActions: input.pendingActions } : {}),
  }
  try {
    await patchAssistantTaskMessage(prisma, input.sessionId, input.taskId, {
      metaMerge: taskMeta,
      content: input.reply || '已完成',
      status: 'DONE',
      media,
      // 找不到同任务气泡时新建。注意这里用**不含 prevMeta** 的 taskMeta：
      // 旧实现把「上一条别的气泡」的 meta 一起铺进新消息，会把别的任务的
      // decisions/subtasks 带过来（历史会话里出现串台的根因之一）。
      createIfMissing: {
        role: 'assistant',
        content: input.reply || '已完成',
        status: 'DONE',
        mediaType: media.urls.length > 0 ? media.type : null,
        mediaUrls: media.urls.length > 0 ? media.urls : undefined,
        meta: taskMeta,
      },
    })
  } catch {
    // 展示层同步失败不影响已落库的 generationTask.result。
  }
}
