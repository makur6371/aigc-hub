import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { generateAudio } from '@/lib/media-provider'
import { deductPoints, refundPoints } from '@/lib/billing/wallet'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { effectivePoints } from '@/lib/pricing'
import { appendChatMessages } from '@/lib/chat-persistence'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { isOwnAssetUrl } from '@/lib/asset-store'

const DEFAULT_EXPIRY_DAYS = 30

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const body = await request.json()
  const { modelId, prompt, lyrics, voiceId, format, duration, sessionId } = body

  if (!modelId || typeof modelId !== 'string') {
    throw new ApiHandlerError('请选择模型', 400)
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ApiHandlerError('内容不能为空', 400)
  }
  // duration 必须有限正数：Infinity/NaN 会在按秒计价里被算成 0 积分
  if (duration != null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)) {
    throw new ApiHandlerError('duration 必须是有限正数', 400)
  }

  const prisma = await getPrisma()

  // 模型解析 → 按秒/按次计价 → 免费额度 → 预扣，统一由 charge-run 负责
  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId: authUser.userId,
      modelType: 'AUDIO',
      modelId,
      durationSec: typeof duration === 'number' ? duration : undefined,
      source: 'api',
    })
  } catch (err) {
    if (err instanceof ChargeRunError) throw new ApiHandlerError(err.message, err.status)
    throw err
  }
  const effectiveCost = run.cost.points
  const chargedPoints = effectiveCost

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
  const recordMeta = {
    lyrics: lyrics || undefined,
    voiceId: voiceId || undefined,
    format: format || undefined,
    // 记下本次是否用了每日免费额度：异步失败在轮询阶段才发现，
    // 那时 costPoints 是 0（免费），光看金额无法判断该不该归还额度
    freeQuota: run.usedFreeQuota || undefined,
  }

  const record = await prisma.audioGenerationRecord.create({
    data: {
      userId: authUser.userId,
      modelId: run.model.id,
      prompt: prompt.trim(),
      costPoints: chargedPoints,
      status: 'PENDING',
      meta: recordMeta,
      runId: run.runId,
      expiresAt,
    },
  })

  // 失败收口（退款 + 归还额度 + 失败日志）统一由 run.fail 处理，不再本地实现


  try {
    const requestDetail = { prompt: prompt.trim(), lyrics, voiceId, format, duration, modelId: run.model.id }
    const result = await run.execute(() => generateAudio({
      baseUrl: run.model.baseUrl,
      apiKey: run.model.apiKey,
      modelName: run.model.modelName,
      userId: authUser.userId,
      adapterId: run.model.adapterId,
      configJson: run.model.configJson,
      modelMetadata: run.model.metadata,
      prompt: prompt.trim(),
      lyrics: lyrics || undefined,
      voiceId: voiceId || undefined,
      format: format || undefined,
    }))

    if (result.audioUrl) {
      await prisma.audioGenerationRecord.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', audioUrl: result.audioUrl },
      })

      // 归集到素材库（source=generated），供"素材库"页播放生成的音频。
      // 只归集我们自己托管的结果 —— 上游外链我们管不了何时失效，
      // 写进去只会留下「记录在、音频打不开」的死条目（与 image/generate 同口径）。
      if (result.audioUrl && isOwnAssetUrl(result.audioUrl)) {
        await prisma.userAsset.create({
          data: {
            userId: authUser.userId,
            type: 'audio',
            url: result.audioUrl,
            fileName: prompt.trim().slice(0, 50) || '生成音频',
            mime: 'audio/mpeg',
            source: 'generated',
          },
        }).catch(() => {})
      }

      if (sessionId) {
        try {
          const session = await prisma.chatSession.findFirst({
            where: { id: sessionId, userId: authUser.userId },
          })
          if (session) {
            // 一次取号写两条，seq 同事务分配（Q-106）
            await appendChatMessages(prisma, session.id, [
              { role: 'user', content: prompt.trim(), meta: { modelId: run.model.id, modelName: run.model.name } },
              {
                role: 'assistant',
                content: '已生成音频',
                mediaType: 'audio',
                mediaUrls: [result.audioUrl],
                meta: { modelId: run.model.id, modelName: run.model.name, cost: chargedPoints, prompt: prompt.trim() },
              },
            ], { modelId: run.model.id })
          }
        } catch { /* ignore */ }
      }

      await run.settle({ nodeLabel: '音频生成', request: requestDetail, response: { audioUrl: result.audioUrl } })
      return success({ recordId: record.id, status: 'SUCCESS', audioUrl: result.audioUrl }, '音频生成成功')
    }

    if (result.taskId) {
      await prisma.audioGenerationRecord.update({
        where: { id: record.id },
        data: {
          meta: {
            ...recordMeta,
            taskId: result.taskId,
            pollPath: result.pollPath || null,
          },
        },
      })
      // 异步任务：交控制权给轮询接口，这里只记录「已派发」
      await run.defer({ nodeLabel: '音频生成', request: requestDetail, taskId: result.taskId })
      return success({ recordId: record.id, status: 'PENDING', taskId: result.taskId }, '音频生成任务已创建，请稍候')
    }

    throw new Error('上游未返回音频数据')
  } catch (err: unknown) {
    // 退款 + 归还额度 + 写失败调用日志（统一实现）
    const errorMessage = await run.fail(err, { nodeLabel: '音频生成', request: { prompt: prompt.trim(), modelId: run.model.id } })
    await prisma.audioGenerationRecord.update({
      where: { id: record.id },
      data: { status: 'FAILED', errorMessage },
    }).catch(() => {})
    throw new ApiHandlerError(errorMessage, 500)
  }
})
