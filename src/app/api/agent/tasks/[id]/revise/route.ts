import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import type { PendingAction } from '@/lib/agent-pending'
import { patchAssistantTaskMessage } from '@/lib/chat-persistence'

export const dynamic = 'force-dynamic'

/** 修订次数上限：防止用户和模型来回拉锯把积分烧光 */
const MAX_REVISION_ROUNDS = 3
/** 修改意见长度上限：这是"一句话说清要改什么"，不是需求文档 */
const NOTE_MAX = 500

/**
 * 让 Agent 按用户的修改意见**重新规划**（confirm 模式的修订循环）。
 *
 * ===== 为什么是"重新规划"而不是"前端直接改字段" =====
 * 用户不该自己去编辑提示词/参数 —— 他们不懂 prompt 工程，改出来往往更差。
 * 正确的抽象是：用户用大白话说要求（「第二张换成暖色调」「只要 2 张」），
 * 模型拿着「上一版方案 + 这条意见」重排，产出一份新的完整方案。
 *
 * 这样模型能做的事远多于改字段：换模型、加减步骤、重排依赖都行。
 *
 * 幂等/并发：用 updateMany 把 PAUSED → REVISING 抢一次，
 * 双击或并发提交只会跑一遍（否则会重复扣规划费、产生两版计划）。
 */
export const POST = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  const authUser = await requireAuth(request)
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { note?: unknown }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : ''
  if (!note) throw new ApiHandlerError('请说说想怎么改', 400)

  const prisma = await getPrisma()
  const task = await prisma.generationTask.findFirst({ where: { id, userId: authUser.userId } })
  if (!task) throw new ApiHandlerError('任务不存在', 404)
  if (task.status !== 'PAUSED') {
    throw new ApiHandlerError('该任务已不在待确认状态（可能已确认或已修订）', 400)
  }

  const payload = (task.payload as Record<string, unknown> | null) || {}
  const pendingActions = Array.isArray(payload.pendingActions) ? (payload.pendingActions as PendingAction[]) : []
  if (pendingActions.length === 0) throw new ApiHandlerError('没有可修订的方案', 400)

  const prevRound = Number(payload.revisionRound)
  const round = Number.isFinite(prevRound) && prevRound >= 0 ? prevRound + 1 : 1
  if (round > MAX_REVISION_ROUNDS) {
    throw new ApiHandlerError(`最多修改 ${MAX_REVISION_ROUNDS} 次，请直接确认或取消`, 400)
  }

  // ===== 原子抢占：PAUSED → REVISING，避免并发重复规划（重复扣费）=====
  const claimed = await prisma.generationTask.updateMany({
    where: { id, userId: authUser.userId, status: 'PAUSED' },
    data: { status: 'REVISING' },
  })
  if (claimed.count === 0) throw new ApiHandlerError('该任务正在处理中，请稍候', 409)

  const { runAgent } = await import('@/lib/agent-executor')
  const emit = () => {}

  try {
    const result = await runAgent({
      emit,
      userId: authUser.userId,
      prompt: String(payload.prompt || ''),
      taskId: id,
      sessionId: task.sessionId || null,
      params: (payload.params as Record<string, unknown> | undefined) || {},
      revision: { note, previous: pendingActions, round },
    })

    const nextPending = result.pendingActions || []
    // 修订后没有任何执行项：说明模型把它理解成了纯聊天/追问，不能当成功落库
    if (nextPending.length === 0) {
      throw new ApiHandlerError(
        result.reply ? `这次修改没能产出可执行的方案：${result.reply.slice(0, 120)}` : '这次修改没能产出可执行的方案，请换个说法',
        400,
      )
    }

    const newPayload = {
      ...payload,
      pendingActions: nextPending,
      revisionRound: round,
      subtasks: result.subtasks,
      revisionNote: note,
    }
    await prisma.generationTask.update({
      where: { id },
      data: {
        status: 'PAUSED',
        payload: JSON.parse(JSON.stringify(newPayload)),
        costPoints: (task.costPoints || 0) + result.totalCost,
        costBeans: (task.costBeans || 0) + result.totalBeans,
        result: JSON.parse(JSON.stringify({ done: false, awaitingConfirm: true, revisionRound: round })),
      },
    })

    // 同步更新会话消息的 meta —— 否则重开历史会话时看到的还是**第一版**方案，
    // 用户会以为自己改的那次没生效（改了库却没改展示，是最典型的"改了但看不到"）。
    if (task.sessionId) {
      try {
        await patchAssistantTaskMessage(prisma, task.sessionId, id, {
          metaMerge: {
            pendingActions: nextPending,
            subtasks: result.subtasks,
            revisionRound: round,
            revisionNote: note,
          },
        })
      } catch { /* 展示同步失败不影响修订本身（任务状态已经落库） */ }
    }

    return {
      taskId: id,
      status: 'PAUSED',
      revisionRound: round,
      pendingActions: nextPending,
      reply: result.reply,
    }
  } catch (err) {
    // 修订失败要**放回 PAUSED**，否则用户连原来的方案都确认不了了（任务卡死在 REVISING）
    await prisma.generationTask.update({
      where: { id },
      data: { status: 'PAUSED' },
    }).catch(() => {})
    if (err instanceof ApiHandlerError) throw err
    throw new ApiHandlerError(err instanceof Error ? err.message : '修改失败，请重试', 500)
  }
})
