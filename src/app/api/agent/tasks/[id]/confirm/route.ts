import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import type { PendingAction } from '@/lib/agent-pending'
import { collectSubtaskMedia, patchAssistantTaskMessage } from '@/lib/chat-persistence'

// Prisma Json 字段需要 JSON 兼容值
const toJson = (v: unknown) => JSON.parse(JSON.stringify(v))

export const dynamic = 'force-dynamic'

/**
 * 确认执行 / 放弃一次「待确认」的 Agent 任务（confirm 模式第二阶段）。
 *
 * ===== 为什么是独立接口，而不是在 /send 的流里等 =====
 * /send 里的执行跑在一个 HTTP 请求里。若在那里 sleep 等用户点确认，
 * 刷新 / 容器重启 / nginx 超时都会让确认永久丢失、任务卡死 —— 所以
 * /send 在有待确认项时**落库并结束**（status=PAUSED），确认走这里重新起跑。
 *
 * ===== 为什么返回 SSE 而不是一次性 JSON（2026-10-08 修复）=====
 * 最初这里返回 JSON，执行期间前端收不到任何事件 —— 于是「排队占位」不会出现，
 * 用户要等全部生成完才看到图（用户原话：「不像之前那样直接把调用排队放到成果区，
 * 而是生成之后才会出现」）。
 *
 * 现在与 /send 完全一致：返回 SSE 流，执行期的 subtask / nodePhase / media
 * 事件**实时**推给前端，前端复用同一套事件处理（agent-stream-handler.ts）。
 *
 * 幂等性：用条件更新把 PAUSED → RUNNING 抢一次，抢到的才执行。
 * 双击确认、重复请求都只会跑一遍（否则会重复扣费出图）。
 */
export const POST = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  const authUser = await requireAuth(request)
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { action?: unknown }
  const action = body.action === 'cancel' ? 'cancel' : 'confirm'

  const prisma = await getPrisma()
  const task = await prisma.generationTask.findFirst({ where: { id, userId: authUser.userId } })
  if (!task) throw new ApiHandlerError('任务不存在', 404)
  if (task.status !== 'PAUSED') {
    throw new ApiHandlerError('该任务不在待确认状态（可能已确认或已过期）', 400)
  }

  const payload = (task.payload as Record<string, unknown> | null) || {}
  const pendingActions = Array.isArray(payload.pendingActions)
    ? (payload.pendingActions as PendingAction[])
    : []
  if (pendingActions.length === 0) {
    throw new ApiHandlerError('没有待确认的执行项', 400)
  }

  // ===== 放弃：标记取消，释放任务（没有产生任何花费，无需退款）=====
  if (action === 'cancel') {
    await prisma.generationTask.update({
      where: { id },
      data: { status: 'CANCELLED', result: toJson({ done: false, cancelled: true, reason: 'user_rejected' }) },
    })
    return { taskId: id, status: 'CANCELLED' }
  }

  // ===== 确认：原子抢占 PAUSED → RUNNING，避免双击重复执行 =====
  const claimed = await prisma.generationTask.updateMany({
    where: { id, userId: authUser.userId, status: 'PAUSED' },
    data: { status: 'RUNNING', error: null },
  })
  if (claimed.count === 0) {
    throw new ApiHandlerError('该任务已被处理', 409)
  }

  const { executePendingActions } = await import('@/lib/agent-executor')
  const { getAgentPreferences } = await import('@/lib/agent-preferences')
  const prefs = await getAgentPreferences(authUser.userId)

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch { /* 流已关闭 / 客户端断开 */ }
      }
      // 心跳：上游排队/生成可能几十秒没有事件，nginx 与浏览器会判定空闲而断开。
      // 以 ':' 开头的行在 SSE 规范里是注释，前端会忽略。
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { /* closed */ }
      }, 15000)

      try {
        const result = await executePendingActions({
          userId: authUser.userId,
          taskId: id,
          prompt: String(payload.prompt || ''),
          sessionId: task.sessionId || null,
          params: (payload.params as Record<string, unknown> | undefined) || {},
          defaultTier: prefs.imageTier,
          pendingActions,
          emit,
        })

        // 任务终态 + 真实产物落库。条件写（Q-D05）：执行期间用户取消时保留 CANCELLED
        const finalWrite = await prisma.generationTask.updateMany({
          where: { id, status: { notIn: ['CANCELLED'] } },
          data: {
            status: 'SUCCEEDED',
            costPoints: result.totalCost,
            costBeans: result.totalBeans,
            result: toJson({ done: true, confirmed: true, subtasks: result.subtasks }),
          },
        })
        if (finalWrite.count === 0) {
          emit({ type: 'cancelled', taskId: id, subtasks: result.subtasks })
        }
        // ===== 回写会话消息 =====
        //
        // 不回写的话：库里图是有的，但用户一刷新，历史消息还是那份「待确认」的旧 meta
        // —— 表现为「刚生成完看得到，刷新就没了」。与 revise 同一个坑：
        // 改了数据却没改展示。
        if (finalWrite.count > 0 && task.sessionId) {
          try {
            const media = collectSubtaskMedia(result.subtasks)
            await patchAssistantTaskMessage(prisma, task.sessionId, id, {
              // pendingActions 必须删掉：留着的话刷新历史又会冒出「待确认」卡片
              metaOmit: ['pendingActions'],
              metaMerge: { subtasks: result.subtasks, confirmed: true },
              media,
            })
          } catch { /* 展示同步失败不影响任务本身（结果已落 generationTask.result） */ }
        }

        // done 让前端收尾（清理残留占位、通知），与 /send 的 done 语义一致
        emit({ type: 'done', taskId: id, subtasks: result.subtasks })
      } catch (err) {
        // 条件写（Q-D05）：执行期间用户取消时保留 CANCELLED，不覆盖成 FAILED
        const failedWrite = await prisma.generationTask.updateMany({
          where: { id, status: { notIn: ['CANCELLED'] } },
          data: { status: 'FAILED', error: err instanceof Error ? err.message : '执行失败' },
        }).catch(() => null)
        if (failedWrite && failedWrite.count === 0) {
          emit({ type: 'cancelled', taskId: id, subtasks: [] })
          return
        }
        const message = err instanceof Error ? err.message : '执行失败'
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
