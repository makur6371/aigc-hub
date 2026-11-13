import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { HISTORY_SUMMARY_STORE_CHARS as SUMMARY_STORE_CHARS } from '@/lib/agent-context-window'
import { getAuthUser } from '@/lib/api-auth'
import { streamChatToUpstream } from '@/lib/llm-provider'
import { generateImage, generateVideo } from '@/lib/media-provider'
import { publicizeReferenceImages } from '@/lib/upstream-image'
import { parseAgentPlan } from '@/lib/agent-plan'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { appendChatMessage } from '@/lib/chat-persistence'
import type { PrismaClient } from '@prisma/client'

// Prisma Json 字段需要 JSON 兼容值
const toJson = (v: unknown) => JSON.parse(JSON.stringify(v))

// P5 统一创作 Agent 入口：
// - 幂等：同一 userId + clientRequestId 命中已有任务，返回原任务，不重复扣费
// - manual：按 modelId 分发（TEXT/VISION 流式、IMAGE、VIDEO）
// - smart：大脑 LLM 规划出子任务计划，串行执行，子任务独立状态/结果
export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, message: '未登录', data: null }, { status: 401 })
  }

  const prisma = await getPrisma()

  let body: {
    sessionId?: string
    clientRequestId?: string
    mode?: 'manual' | 'smart'
    modelId?: string
    prompt?: string
    images?: string[]
    params?: Record<string, unknown>
    skillIds?: string[]
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, message: '请求体格式错误', data: null }, { status: 400 })
  }

  const mode = body.mode === 'smart' ? 'smart' : 'manual'
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const clientRequestId = typeof body.clientRequestId === 'string' && body.clientRequestId ? body.clientRequestId : null

  if (!prompt) {
    return NextResponse.json({ success: false, message: '内容不能为空', data: null }, { status: 400 })
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } })
  if (!user) {
    return NextResponse.json({ success: false, message: '用户不存在', data: null }, { status: 404 })
  }

  // ===== 幂等：同一 clientRequestId 命中已有任务 =====
  if (clientRequestId) {
    const existing = await prisma.generationTask.findUnique({
      where: { userId_clientRequestId: { userId: authUser.userId, clientRequestId } },
    })
    if (existing) {
      return NextResponse.json({
        success: true,
        data: { taskId: existing.id, status: existing.status, result: existing.result, deduped: true },
        message: '任务已存在',
      })
    }
  }

  // 解析会话；未指定时自动创建，确保前后端多轮上下文始终走同一会话
  let session = null
  if (typeof body.sessionId === 'string' && body.sessionId) {
    session = await prisma.chatSession.findFirst({ where: { id: body.sessionId, userId: authUser.userId } })
  }
  if (!session) {
    session = await prisma.chatSession.create({
      data: { userId: authUser.userId, title: '新对话' },
    })
  }

  // 创建任务
  const task = await prisma.generationTask.create({
    data: {
      userId: authUser.userId,
      taskType: 'agent',
      surface: 'chat',
      sessionId: session?.id || null,
      clientRequestId,
      status: 'RUNNING',
      payload: toJson({
        mode,
        prompt,
        params: body.params || {},
        images: Array.isArray(body.images) ? body.images : [],
        skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
      }),
      costPoints: 0,
      costBeans: 0,
    },
  })

  // 有会话时写 user 消息
  if (session) {
    try {
      await appendChatMessage(prisma, session.id, {
        role: 'user',
        content: prompt,
        status: 'DONE',
        meta: { taskId: task.id, mode, images: Array.isArray(body.images) ? body.images : [] },
      }, { modelId: body.modelId || null })
    } catch { /* ignore */ }
  }

  // ===== 分发执行 =====
  // 返回 SSE 流式（manual 文本走流式；smart 规划也流式展示思考）
  const encoder = new TextEncoder()

  let subtasks: Record<string, unknown>[] = []
  let totalCost = 0
  let totalBeans = 0
  let agentTrace: import('@/lib/agent-tool-loop').AgentTraceEntry[] | undefined
  /** 执行路径打点（2.2 决策依据）：'tool-loop' = 新循环，'legacy' = 旧单次规划回落。
   *  没有这个字段就无法判断旧路径还有多少真实用量（payload 里 agentTrace 键是否存在不可靠：
   *  空数组也算存在），因此不能用 LIKE 统计代替。 */
  let agentPath: 'tool-loop' | 'legacy' | undefined
  let latestCheckpoint: import('@/lib/agent-checkpoint').AgentCheckpoint | undefined
  /** confirm 模式：本次规划出来、等用户确认才执行的项 */
  let pendingActions: import('@/lib/agent-pending').PendingAction[] = []

  // ===== 执行与连接解耦（2026-10-01）=====
  //
  // 真实现象（用户报告）：「刷新浏览器或发生中断，这边显示失败了，但其实它还在生成，
  // 只是已经拿不到结果了」。
  //
  // 旧实现的根因：执行 + 落库**整个写在 ReadableStream.start 里**，
  // 一旦客户端断开（request.signal.aborted），catch 分支直接 return ——
  // 后面「写 SUCCEEDED + result」的整段被跳过。而执行器**不监听 signal**，
  // 图照样生成、积分照样扣。加上 agent 不写 CanvasRun（生产 canvas_runs 只有
  // canvas/tool/batch 三种 surface），结果**没有任何落脚点** → 钱花了、图丢了、还显示失败。
  //
  // 所以把「执行 + 落库」抽成与流无关的 runJob：
  //   - 事件通过 listeners 广播给当前还活着的流（断开后没人接，但落库照常）
  //   - 落库固定在做完之后执行，不受连接存活影响
  //
  // ⚠️ 断开时**不能**写 CANCELLED：执行器会轮询 generationTask.status 来判断
  // 「用户是否取消」（agent-executor 的 tryRun），写 CANCELLED 会被误判成真取消而中止执行。
  // 断开 ≠ 取消。
  const listeners = new Set<(line: string) => void>()
  /**
   * 已发出但当时无人监听的事件（订阅时重放）。
   *
   * ⚠️ 为什么必须要有（真实 bug，2026-10-04）：
   * runJob 是 async IIFE，**同步执行到第一个 await 之前**就会 broadcast({type:'task'})，
   * 而客户端订阅（listeners.add）要等 ReadableStream.start() 才开始。
   * 于是那条**唯一携带 sessionId** 的 task 事件在无人监听时被丢弃
   * → 前端永远拿不到 sessionId → 下一条消息传 undefined → 后端新建会话
   * → **每发一条就开一个新会话，历史永远为空**
   *   （实测：2 小时内 25 个会话，其中 24 个只有 1~2 条消息）。
   * 缓存早期事件、订阅时重放，彻底消除这个竞态。
   */
  const earlyBuffer: string[] = []
  const MAX_EARLY_EVENTS = 50
  const broadcast = (obj: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`
    // 还没有订阅者：缓存起来等订阅时重放（否则 task/sessionId 这类早期事件会永久丢失）
    if (listeners.size === 0) {
      if (earlyBuffer.length < MAX_EARLY_EVENTS) earlyBuffer.push(line)
      return
    }
    for (const fn of listeners) { try { fn(line) } catch { /* 该流已关闭 */ } }
  }
  /** 给不需要流也能跑的各模式用：emit 签名与原来一致 */
  const emit = broadcast

  const runJob = (async () => {
    try {
      broadcast({ type: 'task', taskId: task.id, mode, sessionId: session?.id || null })

        if (mode === 'smart') {
          const persistAgentCheckpoint = async (checkpoint: import('@/lib/agent-checkpoint').AgentCheckpoint) => {
            latestCheckpoint = checkpoint
            const current = await prisma.generationTask.findUnique({
              where: { id: task.id },
              select: { payload: true },
            })
            const prev = (current?.payload as Record<string, unknown> | null) || {}
            await prisma.generationTask.update({
              where: { id: task.id },
              data: {
                payload: toJson({
                  ...prev,
                  mode,
                  prompt,
                  params: body.params || {},
                  agentCheckpoint: checkpoint,
                  agentTrace: checkpoint.agentTrace,
                }),
              },
            })
          }
          // ===== SMART：大脑规划 =====
          const smartResult = await runSmartMode({
            emit,
            body,
            user,
            taskId: task.id,
            session,
            prisma,
            onCheckpoint: persistAgentCheckpoint,
          })
          subtasks = smartResult.subtasks
          totalCost = smartResult.totalCost
          totalBeans = smartResult.totalBeans
          pendingActions = smartResult.pendingActions || []
          agentTrace = smartResult.agentTrace
          agentPath = smartResult.path
          latestCheckpoint = smartResult.checkpoint || latestCheckpoint
        } else {
          // ===== MANUAL：按模型分发 =====
          const result = await runManualMode({
            emit,
            body,
            user,
            taskId: task.id,
            session,
            prisma,
          })
          subtasks = result.subtasks
          totalCost = result.totalCost
          totalBeans = result.totalBeans
        }

        // 更新任务终态：若已被取消则不再覆盖为 SUCCEEDED
        const curStatus = await prisma.generationTask.findUnique({
          where: { id: task.id },
          select: { status: true },
        })
        if (curStatus?.status === 'CANCELLED') {
          // 保留取消状态，只落已完成部分的成本与结果（供前端/后台查证）
          await prisma.generationTask.update({
            where: { id: task.id },
            data: {
              payload: toJson({
                mode,
                prompt,
                params: body.params || {},
                images: Array.isArray(body.images) ? body.images : [],
                skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
                subtasks,
                agentTrace,
                agentPath,
                agentCheckpoint: latestCheckpoint,
              }),
              costPoints: totalCost,
              costBeans: totalBeans,
              result: { done: false, cancelled: true },
            },
          }).catch(() => {})
          emit({ type: 'cancelled', statusCode: 'CANCELLED', subtasks, costPoints: totalCost, costBeans: totalBeans })
          return
        }
        // ===== confirm 模式：有待确认项就停在 PAUSED，把计划整体落库等用户确认 =====
        //
        // 为什么不在这里 sleep 等用户点确认：任务跑在一个 HTTP 请求里，
        // 挂起 = 挂在内存等几分钟，刷新/重启/超时就永远丢了。
        // 落库 + 结束请求，确认走独立接口（见 /api/agent/tasks/[id]/confirm）。
        if (pendingActions.length > 0) {
          const pausedTask = await prisma.generationTask.update({
            where: { id: task.id },
            data: {
              status: 'PAUSED',
              payload: toJson({
                mode,
                prompt,
                params: body.params || {},
                images: Array.isArray(body.images) ? body.images : [],
                skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
                subtasks,
                pendingActions,
                agentTrace,
                agentPath,
                agentCheckpoint: latestCheckpoint,
              }),
              costPoints: totalCost,
              costBeans: totalBeans,
              result: { done: false, awaitingConfirm: true },
            },
          })
          emit({
            type: 'awaitingConfirm',
            taskId: pausedTask.id,
            pendingActions,
            subtasks,
            costPoints: totalCost,
            costBeans: totalBeans,
          })
          return
        }
        // 终态条件写（Q-D05）：「先读 status 再无条件 update」的窗口里用户可能点取消，
        // 无条件写会把 CANCELLED 覆盖成 SUCCEEDED。改为原子条件写：
        // 0 行命中 = 执行期间已被取消（或任务被删），保留取消态只 emit。
        const finalWrite = await prisma.generationTask.updateMany({
          where: { id: task.id, status: { notIn: ['CANCELLED'] } },
          data: {
            status: 'SUCCEEDED',
            payload: toJson({
              mode,
              prompt,
              params: body.params || {},
              images: Array.isArray(body.images) ? body.images : [],
              skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
              subtasks,
              agentTrace,
              agentPath,
              agentCheckpoint: latestCheckpoint,
            }),
            costPoints: totalCost,
            costBeans: totalBeans,
            result: { done: true },
          },
        })
        if (finalWrite.count === 0) {
          emit({ type: 'cancelled', statusCode: 'CANCELLED', subtasks, costPoints: totalCost, costBeans: totalBeans })
          return
        }
        emit({ type: 'done', taskId: task.id, subtasks, costPoints: totalCost, costBeans: totalBeans })
      } catch (err: unknown) {
        // 客户端断开（refresh / 切页 / AbortSignal）**不是取消、也不是失败**。
        //
        // 旧实现这里写 CANCELLED 并 return —— 那是本次要修的核心 bug，理由见上方 runJob 注释：
        //   1) 执行器读该状态判断「用户是否取消」，写 CANCELLED 会被误判成真取消而中止后续交付物；
        //   2) 更糟的是它把「落结果」也跳过了 → 图生成了却没有落脚点。
        //
        // 现在：断开只是「这条通知线没了」，任务照常跑完、照常落库（runJob 尾部统一做）。
        // 仅当**真正出错**（非断开）才写 FAILED。
        const clientGone = request.signal?.aborted
          || (err instanceof TypeError && String(err.message).includes('enqueue'))
        if (clientGone) {
          console.warn('[agent/send] 客户端已断开，任务继续在后台执行并落库:', task.id)
          return
        }
        const message = err instanceof Error ? err.message : '生成失败'
        // 打完整堆栈：这个 catch 之前只透传 message、不打任何日志，
        // 导致线上出现「Cannot access 'H' before initialization」这类错误时无法定位
        // （错误来源、调用栈全都拿不到）。诊断信息必须留在服务端日志里。
        console.error('[agent/send] 智能模式失败:', err)
        // 失败：更新任务 + 若有会话写失败消息
        // 条件写（Q-D05）：执行期间用户点取消时保留 CANCELLED，不覆盖成 FAILED
        const failedWrite = await prisma.generationTask.updateMany({
          where: { id: task.id, status: { notIn: ['CANCELLED'] } },
          data: {
            status: 'FAILED',
            error: message,
            payload: toJson({
              mode,
              prompt,
              params: body.params || {},
              images: Array.isArray(body.images) ? body.images : [],
              skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
              subtasks,
              agentTrace: latestCheckpoint?.agentTrace || agentTrace,
              agentPath,
              agentCheckpoint: latestCheckpoint,
            }),
          },
        }).catch(() => null)
        if (failedWrite && failedWrite.count === 0) {
          emit({ type: 'cancelled', taskId: task.id, subtasks, costPoints: totalCost, costBeans: totalBeans })
          return
        }
        if (session) {
          try {
            // 失败原因随 meta 持久化，前端气泡展示具体原因而非笼统文案
            await appendChatMessage(prisma, session.id, {
              role: 'assistant',
              content: '',
              status: 'FAILED',
              meta: { taskId: task.id, error: message },
            })
          } catch { /* ignore */ }
        }
        emit({ type: 'error', message })
    } finally {
      // 无论成功/取消/失败/断开，都通知所有还活着的流「跑完了」，让前端能收尾。
      // 断开后没有监听者，这里是个空操作 —— 但落库已经在上面做完。
      broadcast({ type: '__closed', taskId: task.id })
    }
  })()
  // 防止 unhandledRejection：runJob 内部已 try/catch，这里再兜一层
  void runJob.catch((e) => console.error('[agent/send] runJob 未捕获异常:', e))

  // ===== 流：只负责「把 runJob 的事件转发给这个客户端」 =====
  const stream = new ReadableStream({
    start(controller) {
      const send = (line: string) => {
        try { controller.enqueue(encoder.encode(line)) } catch { /* 流已关闭 */ }
      }
      listeners.add(send)
      // 重放「订阅之前」就已经 broadcast 的事件（关键是携带 sessionId 的 task 事件，
      // 见上方 earlyBuffer 注释：丢了它前端就永远拿不到 sessionId）
      for (const line of earlyBuffer) send(line)
      earlyBuffer.length = 0
      // SSE 心跳：规划模型可能长时间不吐字（多模态读图 + 长推理），期间没有任何字节时
      // nginx / 浏览器会判定连接空闲而断开 —— 用户看到「跑到一半没了」。每 15s 发一个
      // SSE 注释行保活（以 ':' 开头，规范里被忽略）。与工具执行流同一口径。
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { /* 流已关闭 */ }
      }, 15000)
      // 客户端断开 → 把自己从广播列表移除（不中止 runJob）
      const detach = () => {
        clearInterval(heartbeat)
        listeners.delete(send)
      }
      request.signal?.addEventListener('abort', detach, { once: true })
      // runJob 结束时关闭这条流（迟到的事件不需要了）
      const closer = (line: string) => {
        if (!line.includes('"__closed"')) return
        detach()
        try { controller.close() } catch { /* already closed */ }
      }
      listeners.add(closer)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

// ===== MANUAL 模式：按 modelId 分发 =====
async function runManualMode(opts: {
  emit: (obj: Record<string, unknown>) => void
  body: { modelId?: string; prompt?: string; images?: string[]; params?: Record<string, unknown> }
  user: { id: string; points: number; beans: number }
  taskId: string
  session: { id: string } | null
  prisma: PrismaClient
}): Promise<{
  subtasks: Record<string, unknown>[]
  totalCost: number
  totalBeans: number
  /** confirm 模式：本次规划出来、等用户确认才执行的项 */
  pendingActions?: import('@/lib/agent-pending').PendingAction[]
  agentTrace?: import('@/lib/agent-tool-loop').AgentTraceEntry[]
}> {
  const { emit, body, user, session, prisma } = opts
  const modelId = body.modelId
  if (!modelId) {
    throw new Error('请选择模型')
  }

  const prompt = String(body.prompt || '')
  const params = (body.params || {}) as Record<string, unknown>
  // Q-D07：参考图统一公网化（与 legacy/工具循环同口径）。站内相对路径（/api/asset/...）
  // 直接交给上游会静默失效（上游 fetch 不到本机地址）；过期素材在这里就报错，尚未扣费。
  const referenceImages = await publicizeReferenceImages(body.images, user.id)

  // 模型解析 + 计费 + 退款 + 调用日志统一走 charge-run（与 image/video/audio 生成路由同一实现）。
  // 这里只需要先知道用户选的是哪一类能力，好走到对应分支；计费与失败退款都交给 charge-run。
  const picked = await prisma.modelConfig.findUnique({ where: { id: modelId }, select: { type: true } })
  if (!picked) throw new Error('所选模型不可用')
  const modelType = picked.type as 'TEXT' | 'VISION' | 'IMAGE' | 'VIDEO' | 'AUDIO'

  const startRun = async (type: typeof modelType, extra?: { width?: number; height?: number; durationSec?: number }) => {
    try {
      return await chargeRun({
        userId: user.id,
        modelType: type,
        modelId,
        width: extra?.width,
        height: extra?.height,
        durationSec: extra?.durationSec,
        source: 'agent',
        runId: opts.taskId,
      })
    } catch (err) {
      if (err instanceof ChargeRunError) throw new Error(err.message)
      throw err
    }
  }

  // ===== VIDEO：扣豆 =====
  if (modelType === 'VIDEO') {
    const run = await startRun('VIDEO', {
      durationSec: typeof params.duration === 'number' ? params.duration : undefined,
      width: typeof params.width === 'number' ? params.width : undefined,
      height: typeof params.height === 'number' ? params.height : undefined,
    })
    const model = run.model
    const beansCost = run.cost.beans
    const requestDetail = { prompt: prompt.slice(0, 500), modelId: model.id, params }
    emit({ type: 'subtask', index: 0, label: '生成视频', status: 'running' })
    try {
      const result = await run.execute(() => generateVideo({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelName: model.modelName,
        prompt,
        userId: user.id,
        width: typeof params.width === 'number' ? params.width : undefined,
        height: typeof params.height === 'number' ? params.height : undefined,
        duration: typeof params.duration === 'number' ? params.duration : undefined,
        aspectRatio: typeof params.aspectRatio === 'string' ? params.aspectRatio : undefined,
        // 首帧参考图：Agent 底座要求强制传递防形变（与 agent-executor 视频分支同口径）
        firstFrame: referenceImages.length > 0 ? referenceImages[0] : undefined,
        adapterId: model.adapterId,
        configJson: model.configJson,
        modelMetadata: model.metadata,
      }))
      if (result.videoUrl) {
        emit({ type: 'media', kind: 'video', url: result.videoUrl, index: 0 })
        // B4: 建 SUCCESS record 归集"我的视频"
        await prisma.videoGenerationRecord.create({
          data: {
            userId: user.id,
            modelId: model.id,
            prompt,
            videoUrl: result.videoUrl,
            costPoints: 0,
            beansCost,
            status: 'SUCCESS',
            // 用 run.runId：与本次扣费流水、调用日志同一个事务号（Q-D09①）
            runId: run.runId,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        }).catch(() => {})
        await writeAssistantMedia(session, prisma, 'video', [result.videoUrl], model, beansCost, prompt)
        await run.settle({ nodeLabel: 'Agent 视频生成', request: requestDetail, response: { videoUrl: result.videoUrl } })
        return { subtasks: [{ type: 'VIDEO', status: 'success', videoUrl: result.videoUrl }], totalCost: 0, totalBeans: beansCost }
      }
      if (result.taskId) {
        // B4: taskId → 建 PENDING record，退款统一走 /api/video/status/[recordId]
        // 这里不能 settle（真正的成败在轮询阶段才知道），用 defer 写一条已派发日志；
        // freeQuota 标记供轮询阶段判断该不该归还额度。
        const record = await prisma.videoGenerationRecord.create({
          data: {
            userId: user.id,
            modelId: model.id,
            prompt,
            costPoints: 0,
            beansCost,
            status: 'PENDING',
            meta: { taskId: result.taskId, pollPath: result.pollPath || null, freeQuota: run.usedFreeQuota || undefined },
            runId: run.runId,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        })
        emit({ type: 'pendingVideo', recordId: record.id, taskId: result.taskId, index: 0 })
        await run.defer({ nodeLabel: 'Agent 视频生成', request: requestDetail })
        return { subtasks: [{ type: 'VIDEO', status: 'pending', recordId: record.id }], totalCost: 0, totalBeans: beansCost }
      }
      throw new Error('上游未返回视频数据')
    } catch (err) {
      await run.fail(err, { nodeLabel: 'Agent 视频生成', request: requestDetail })
      throw err
    }
  }

  // ===== IMAGE：扣积分 =====
  if (modelType === 'IMAGE') {
    const run = await startRun('IMAGE', {
      width: typeof params.width === 'number' ? params.width : undefined,
      height: typeof params.height === 'number' ? params.height : undefined,
    })
    const model = run.model
    const cost = run.cost.points
    const requestDetail = { prompt: prompt.slice(0, 500), modelId: model.id, width: params.width, height: params.height }
    emit({ type: 'subtask', index: 0, label: '生成图片', status: 'running' })
    try {
      const { imageUrl } = await run.execute(() => generateImage({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelName: model.modelName,
        prompt,
        userId: user.id,
        width: typeof params.width === 'number' ? params.width : undefined,
        height: typeof params.height === 'number' ? params.height : undefined,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        adapterId: model.adapterId,
        configJson: model.configJson,
        modelMetadata: model.metadata,
      }))
      emit({ type: 'media', kind: 'image', url: imageUrl, index: 0 })
      await writeAssistantMedia(session, prisma, 'image', [imageUrl], model, cost, prompt)
      await run.settle({ nodeLabel: 'Agent 图片生成', request: requestDetail, response: { url: imageUrl } })
      return { subtasks: [{ type: 'IMAGE', status: 'success', imageUrl }], totalCost: cost, totalBeans: 0 }
    } catch (err) {
      await run.fail(err, { nodeLabel: 'Agent 图片生成', request: requestDetail })
      throw err
    }
  }

  // ===== TEXT / VISION：流式 =====
  const run = await startRun(modelType === 'VISION' ? 'VISION' : 'TEXT')
  const model = run.model
  const cost = run.cost.points
  const requestDetail = { prompt: prompt.slice(0, 500), modelId: model.id, images: body.images?.length || 0 }
  emit({ type: 'subtask', index: 0, label: 'AI 回复', status: 'running' })
  let fullContent = ''
  let fullReasoning = ''
  try {
    await run.execute(() => streamChatToUpstream(
      model.baseUrl,
      model.apiKey,
      model.modelName,
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        supportsVision: model.supportsVision || modelType === 'VISION',
        images: referenceImages.length > 0 ? referenceImages : undefined,
        modelMetadata: model.metadata,
      },
      (text) => {
        fullContent += text
        emit({ type: 'content', content: text })
      },
      (reasoning) => {
        fullReasoning += reasoning
        emit({ type: 'reasoning', reasoning })
      },
      { adapterId: model.adapterId, configJson: model.configJson },
      undefined,
      user.id,
    ))
  } catch (err) {
    await run.fail(err, { nodeLabel: 'Agent 对话', request: requestDetail })
    throw err
  }

  await writeAssistantText(session, prisma, fullContent, fullReasoning, model, cost, prompt, opts.taskId)
  await run.settle({ nodeLabel: 'Agent 对话', request: requestDetail, response: { reply: fullContent.slice(0, 2000) } })
  emit({ type: 'subtask', index: 0, label: 'AI 回复', status: 'success' })
  return { subtasks: [{ type: 'TEXT', status: 'success', content: fullContent.slice(0, 200) }], totalCost: cost, totalBeans: 0 }
}

async function writeAssistantText(session: { id: string } | null, prisma: PrismaClient, content: string, reasoning: string, model: { id: string; name: string }, cost: number, prompt: string, taskId: string) {
  if (!session) return
  try {
    await appendChatMessage(prisma, session.id, {
      role: 'assistant',
      content,
      reasoning: reasoning || null,
      status: 'DONE',
      meta: { modelId: model.id, modelName: model.name, cost, prompt, taskId },
    })
    // 首次回复后自动命名会话（只在默认标题下触发）
    await autoRenameSession(prisma, session.id, prompt)
  } catch { /* ignore */ }
}

async function writeAssistantMedia(session: { id: string } | null, prisma: PrismaClient, mediaType: string, urls: string[], model: { id: string; name: string }, cost: number, prompt: string) {
  if (!session) return
  try {
    await appendChatMessage(prisma, session.id, {
      role: 'assistant',
      content: mediaType === 'image' ? '已生成图片' : '已生成视频',
      status: 'DONE',
      mediaType,
      mediaUrls: urls,
      meta: { modelId: model.id, modelName: model.name, cost, prompt },
    })
    await autoRenameSession(prisma, session.id, prompt)
  } catch { /* ignore */ }
}

/** 首次回复后自动命名：只在标题为默认"新对话"时更新为 prompt 前 40 字 */
async function autoRenameSession(prisma: PrismaClient, sessionId: string, prompt: string) {
  try {
    const s = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } })
    if (s && s.title === '新对话') {
      await prisma.chatSession.update({ where: { id: sessionId }, data: { title: prompt.slice(0, 40) } })
    }
  } catch { /* ignore */ }
}

// ===== SMART 模式：大脑规划 + 串行子任务 =====
async function runSmartMode(opts: {
  emit: (obj: Record<string, unknown>) => void
  body: { prompt?: string; images?: string[]; params?: Record<string, unknown>; skillIds?: string[] }
  user: { id: string; points: number; beans: number }
  taskId: string
  session: { id: string } | null
  prisma: PrismaClient
  onCheckpoint?: (checkpoint: import('@/lib/agent-checkpoint').AgentCheckpoint) => void | Promise<void>
}): Promise<{
  subtasks: Record<string, unknown>[]
  totalCost: number
  totalBeans: number
  pendingActions?: import('@/lib/agent-pending').PendingAction[]
  agentTrace?: import('@/lib/agent-tool-loop').AgentTraceEntry[]
  /** 执行路径打点：'tool-loop' | 'legacy'（2.2 决策依据，见 runJob 的 agentPath 注释） */
  path?: 'tool-loop' | 'legacy'
  checkpoint?: import('@/lib/agent-checkpoint').AgentCheckpoint
}> {
  const { emit, body, user, session, prisma } = opts
  const prompt = String(body.prompt || '')

  // 完整 Agent 执行器：规划（上下文/素材/模型候选）→ 依赖并发执行 → 视觉复盘
  const { runAgent, reviewAgentOutputs } = await import('@/lib/agent-executor')
  const { getAgentPreferences } = await import('@/lib/agent-preferences')
  const userPrefs = await getAgentPreferences(user.id)

          const result = await runAgent({
            emit,
            userId: user.id,
            prompt,
            images: body.images,
            sessionId: session?.id || null,
            taskId: opts.taskId,
            params: body.params || {},
            skillIds: Array.isArray(body.skillIds) ? body.skillIds.filter((s): s is string => typeof s === 'string') : undefined,
            preferences: { ...userPrefs },
            onCheckpoint: opts.onCheckpoint,
          })

  // B10: 追加会话滚动摘要（滚动保留尾部 SUMMARY_STORE_CHARS 字）
  //
  // 条目形如「<需求> → <回复> [产物: 4张图片]」：
  //   产物数量必须写进来 —— 摘要覆盖的是「最近 12 条消息」窗口**之外**的更早轮次，
  //   那是模型回忆早期内容的唯一来源；不写产物，它不知道那些轮次出了什么，
  //   「基于上一版改」就失去依据。
  if (session) {
    try {
      const s = await prisma.chatSession.findUnique({ where: { id: session.id }, select: { summary: true } })
      // 产物统计（与下面落库用同一份 subtasks，口径一致）
      let producedImages = 0
      let producedVideos = 0
      for (const st of result.subtasks) {
        if (st.status !== 'success') continue
        if (Array.isArray(st.imageUrls)) producedImages += st.imageUrls.length
        else if (st.imageUrl) producedImages += 1
        if (st.videoUrl) producedVideos += 1
      }
      const produced = [
        producedImages > 0 ? `${producedImages}张图片` : '',
        producedVideos > 0 ? `${producedVideos}个视频` : '',
      ].filter(Boolean).join('+')
      // 条目长度放宽（100/200 → 160/320，2026-10-04 随上下文窗口一起放宽）：
      // 原长度会把「用户的具体要求」和「Agent 的方案说明」截成半句，
      // 而摘要是窗口外轮次的唯一回忆来源，截太狠等于把早期约定丢了。
      const entry = `${prompt.slice(0, 160)} → ${(result.reply || '').slice(0, 320)}${produced ? ` [产物: ${produced}]` : ''}`
      const merged = `${s?.summary ? s.summary + '\n' : ''}${entry}`.slice(-SUMMARY_STORE_CHARS)
      await prisma.chatSession.update({ where: { id: session.id }, data: { summary: merged } })
    } catch { /* ignore */ }
  }

  // 会话消息持久化（回复 + 决策 + 媒体合并，刷新不丢）
  if (session) {
    try {
      // B6: 收集成功 subtask 的媒体（imageUrls 数组 + videoUrl）
      const mediaUrls: string[] = []
      let mediaType: string | null = null
      for (const s of result.subtasks) {
        if (s.status !== 'success') continue
        if (Array.isArray(s.imageUrls)) {
          for (const u of s.imageUrls) { mediaUrls.push(String(u)); if (!mediaType) mediaType = 'image' }
        } else if (s.imageUrl) {
          mediaUrls.push(String(s.imageUrl)); if (!mediaType) mediaType = 'image'
        }
        if (s.videoUrl) {
          mediaUrls.push(String(s.videoUrl)); mediaType = 'video'
        }
      }

      // askQuestions 一并落库：刷新/重开历史会话时仍能渲染成可点选项（否则退化成纯文字）
      // subtasks 一并落库：历史回显用它还原「执行计划」卡片（每步 title/status/error）。
      // 之前只存 decisions/askQuestions —— 重开会话时计划卡整块消失，
      // 而同一个会话刚聊完时却看得到（那份靠内存 state）。
      await appendChatMessage(prisma, session.id, {
        role: 'assistant',
        content: result.reply || '已完成',
        status: 'DONE',
        mediaType: mediaType || null,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        meta: {
          taskId: opts.taskId,
          mode: 'smart',
          decisions: result.decisions,
          askQuestions: result.askQuestions,
          subtasks: result.subtasks,
          ...(result.pendingActions && result.pendingActions.length > 0 ? { pendingActions: result.pendingActions } : {}),
        },
      })
      // 智能模式首次回复后自动命名会话
      await autoRenameSession(prisma, session.id, opts.body.prompt || '')
    } catch { /* ignore */ }
  }

  emit({ type: 'agentReply', reply: result.reply, decisions: result.decisions, askQuestions: result.askQuestions })

  // projectHandoff 通知前端
  if (result.projectHandoff) {
    emit({ type: 'projectHandoff', handoff: result.projectHandoff })
  }

  // 视觉复盘：收集图片产物（含 B1 多图的 imageUrls 数组）
  const imageResults = result.subtasks.flatMap((s) => {
    if (s.status !== 'success') return []
    const urls = Array.isArray(s.imageUrls) ? s.imageUrls : s.imageUrl ? [s.imageUrl] : []
    return urls.map((url: string) => ({ taskId: String(s.id || ''), url: String(url) }))
  })
  // 视觉复盘会额外调用带图模型（按次计费）。交接文档既定计划：第一期默认关，
  // 需要时用 AGENT_REVIEW_ENABLED=1 打开，避免用户每次出图都被多扣一次复盘费。
  const reviewEnabled = process.env.AGENT_REVIEW_ENABLED === '1'
  if (reviewEnabled && imageResults.length > 0) {
    await reviewAgentOutputs({
      userId: user.id,
      prompt,
      foundationSummary: result.foundationSummary,
      imageUrls: imageResults,
      emit,
    })
    // reviewAgentOutputs 内部已 emit review 终态，不重复 emit
  }

  return {
    subtasks: result.subtasks,
    totalCost: result.totalCost,
    totalBeans: result.totalBeans,
    pendingActions: result.pendingActions,
    agentTrace: result.agentTrace,
    path: result.path,
    checkpoint: result.checkpoint,
  }
}
