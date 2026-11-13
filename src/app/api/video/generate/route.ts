import { NextRequest } from 'next/server'
import { roundPoints } from '@/lib/pricing'
import { getPrisma } from '@/lib/prisma'
import { generateVideo } from '@/lib/media-provider'
import { deductBeans, refundBeans } from '@/lib/billing/wallet'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { validateVideoParams } from '@/lib/billing/billing-plans'
import { appendChatMessages } from '@/lib/chat-persistence'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { isOwnAssetUrl } from '@/lib/asset-store'

const DEFAULT_EXPIRY_DAYS = 30

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const body = await request.json()
  const { modelId, prompt, negativePrompt, width, height, duration, aspectRatio, resolution, firstFrame, lastFrame, audio, referenceImages, sessionId } = body
  // 参考图统一成数组（多图参考生视频）；用于计费因子与透传上游
  const refImages: string[] = Array.isArray(referenceImages)
    ? referenceImages.filter((u: unknown): u is string => typeof u === 'string' && !!u)
    : (typeof referenceImages === 'string' && referenceImages ? [referenceImages] : [])

  if (!modelId || typeof modelId !== 'string') {
    throw new ApiHandlerError('请选择模型', 400)
  }
  // duration/宽高必须有限：JSON 里 1e999 会解析成 Infinity，NaN/Infinity 会
  // 绕过「> 0」判断并在按秒计价里算出 0 豆（见 billing-plans.safeSeconds）。
  for (const [k, v] of Object.entries({ duration, width, height })) {
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new ApiHandlerError(`${k} 必须是有限正数`, 400)
    }
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ApiHandlerError('提示词不能为空', 400)
  }

  const prisma = await getPrisma()

  // 能力约束前置校验：模型声明了时长/分辨率/比例/素材上限时，提交前就拦住非法参数，
  // 避免"提交后才失败、还要退款"（见 metadata.video.constraints）。
  {
    const target = await prisma.modelConfig.findFirst({ where: { id: modelId, type: 'VIDEO' }, select: { metadata: true } })
    const constraintErr = validateVideoParams(
      { costPoints: 0, metadata: (target?.metadata as Record<string, unknown> | null) ?? null },
      {
        duration: typeof duration === 'number' ? duration : undefined,
        resolution: typeof resolution === 'string' ? resolution : undefined,
        ratio: aspectRatio || undefined,
        imageCount: refImages.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0),
      },
    )
    if (constraintErr) throw new ApiHandlerError(constraintErr, 400)
  }

  // 模型解析 → 按秒/一口价豆计价 → 免费额度 → 预扣，统一由 charge-run 负责（视频走豆）
  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId: authUser.userId,
      modelType: 'VIDEO',
      modelId,
      durationSec: typeof duration === 'number' ? duration : undefined,
      // 输入素材计费因子：参考图张数（含首尾帧）
      imageCount: refImages.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0),
      // 分辨率档位价：按 768P/1080P 等档位定价时用
      resolution: typeof resolution === 'string' ? resolution : undefined,
      source: 'api',
    })
  } catch (err) {
    if (err instanceof ChargeRunError) throw new ApiHandlerError(err.message, err.status)
    throw err
  }
  const effectiveCost = run.cost.beans
  const chargedBeans = effectiveCost

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
  const recordMeta = {
    width: typeof width === 'number' ? width : undefined,
    height: typeof height === 'number' ? height : undefined,
    duration: typeof duration === 'number' ? duration : undefined,
    aspectRatio: aspectRatio || undefined,
    firstFrame: firstFrame || undefined,
    lastFrame: lastFrame || undefined,
    audio: audio || undefined,
    referenceImages: refImages.length > 0 ? refImages : undefined,
    // 记下本次是否用了每日免费额度：异步任务失败在「轮询阶段」才发现，
    // 那时 beansCost 是 0（免费），光看金额无法判断该不该归还额度。
    freeQuota: run.usedFreeQuota || undefined,
  }

  const record = await prisma.videoGenerationRecord.create({
    data: {
      userId: authUser.userId,
      modelId: run.model.id,
      prompt: prompt.trim(),
      costPoints: 0,
      beansCost: chargedBeans,
      status: 'PENDING',
      meta: recordMeta,
      // 计费事务号（Q-D09①）：流水 ↔ 调用日志 ↔ 这条记录可对平，
      // 「这笔豆扣在哪个视频任务上」不再靠时间戳猜（也是 Q-B01 任务列的数据源）
      runId: run.runId,
      expiresAt,
    },
  })

  // 失败收口（退款 + 归还额度 + 失败日志）统一由 run.fail 处理，不再本地实现


  try {
    const requestDetail = { prompt: prompt.trim(), width, height, duration, aspectRatio, modelId: run.model.id }
    const result = await run.execute(() => generateVideo({
      baseUrl: run.model.baseUrl,
      apiKey: run.model.apiKey,
      modelName: run.model.modelName,
      prompt: prompt.trim(),
      userId: authUser.userId,
      adapterId: run.model.adapterId,
      configJson: run.model.configJson,
      modelMetadata: run.model.metadata,
      negativePrompt: negativePrompt || undefined,
      width: typeof width === 'number' ? width : undefined,
      height: typeof height === 'number' ? height : undefined,
      duration: typeof duration === 'number' ? duration : undefined,
      aspectRatio: aspectRatio || undefined,
      resolution: typeof resolution === 'string' ? resolution : undefined,
      firstFrame: firstFrame || undefined,
      lastFrame: lastFrame || undefined,
      audio: audio || undefined,
      referenceImages: refImages.length > 0 ? refImages : undefined,
    }))

    if (result.videoUrl) {
      await prisma.videoGenerationRecord.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', videoUrl: result.videoUrl },
      })

      // 归集到素材库（source=generated），供"素材库"页展示生成的视频。
      // 只归集我们自己托管的结果 —— 上游外链我们管不了何时失效，
      // 写进去只会留下「记录在、视频打不开」的死条目（与 image/generate 同口径）。
      if (result.videoUrl && isOwnAssetUrl(result.videoUrl)) {
        await prisma.userAsset.create({
          data: {
            userId: authUser.userId,
            type: 'video',
            url: result.videoUrl,
            fileName: prompt.trim().slice(0, 50) || '生成视频',
            mime: 'video/*',
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
                content: '已生成视频',
                mediaType: 'video',
                mediaUrls: [result.videoUrl],
                meta: { modelId: run.model.id, modelName: run.model.name, cost: chargedBeans, prompt: prompt.trim() },
              },
            ], { modelId: run.model.id })
          }
        } catch { /* ignore */ }
      }

      await run.settle({ nodeLabel: '视频生成', request: requestDetail, response: { videoUrl: result.videoUrl } })
      return success({ recordId: record.id, status: 'SUCCESS', videoUrl: result.videoUrl }, '视频生成成功')
    }

    if (result.taskId) {
      await prisma.videoGenerationRecord.update({
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
      await run.defer({ nodeLabel: '视频生成', request: requestDetail, taskId: result.taskId })
      return success({ recordId: record.id, status: 'PENDING', taskId: result.taskId }, '视频生成任务已创建，请稍候')
    }

    throw new Error('上游未返回视频数据')
  } catch (err: unknown) {
    // 退款（豆）+ 归还额度 + 写失败调用日志（统一实现）
    const errorMessage = await run.fail(err, { nodeLabel: '视频生成', request: { prompt: prompt.trim(), modelId: run.model.id } })
    await prisma.videoGenerationRecord.update({
      where: { id: record.id },
      data: { status: 'FAILED', errorMessage },
    }).catch(() => {})
    throw new ApiHandlerError(errorMessage, 500)
  }
})
