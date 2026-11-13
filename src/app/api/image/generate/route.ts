import { NextRequest } from 'next/server'
import { MEDIA_RECORD_STATUS } from '@/lib/status-vocab'
import { getPrisma } from '@/lib/prisma'
import { generateImage } from '@/lib/media-provider'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { isOwnAssetUrl } from '@/lib/asset-store'
import { appendChatMessages } from '@/lib/chat-persistence'

const DEFAULT_EXPIRY_DAYS = 30

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const body = await request.json()
  const { modelId, prompt, negativePrompt, width, height, sessionId } = body

  if (!modelId || typeof modelId !== 'string') {
    throw new ApiHandlerError('请选择模型', 400)
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ApiHandlerError('提示词不能为空', 400)
  }

  const prisma = await getPrisma()

  // 模型解析 → 档位计价 → 免费额度 → 预扣 → 失败退款 → 调用日志，统一由 charge-run 负责。
  // （原先本路由手写这一整套，与 upscale / batch-edit / audio / video 五份实现重复。）
  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId: authUser.userId,
      modelType: 'IMAGE',
      modelId,
      width: typeof width === 'number' ? width : undefined,
      height: typeof height === 'number' ? height : undefined,
      source: 'api',
    })
  } catch (err) {
    if (err instanceof ChargeRunError) throw new ApiHandlerError(err.message, err.status)
    throw err
  }
  const cost = run.cost.points
  const chargedPoints = cost
  const actualWidth = run.imageSize?.width ?? (typeof width === 'number' ? width : undefined)
  const actualHeight = run.imageSize?.height ?? (typeof height === 'number' ? height : undefined)
  const requestDetail = { prompt: prompt.trim(), negativePrompt, width: actualWidth, height: actualHeight, modelId: run.model.id }

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)

  let imageUrl: string
  try {
    const result = await run.execute(() => generateImage({
      baseUrl: run.model.baseUrl,
      apiKey: run.model.apiKey,
      modelName: run.model.modelName,
      prompt: prompt.trim(),
      userId: authUser.userId,
      negativePrompt: negativePrompt || undefined,
      width: actualWidth,
      height: actualHeight,
      adapterId: run.model.adapterId,
      configJson: run.model.configJson as Record<string, unknown> | null,
      modelMetadata: (run.model.metadata as Record<string, unknown> | null) ?? null,
    }))
    imageUrl = result.imageUrl
    if (!imageUrl) {
      throw new Error('上游未返回图片')
    }
  } catch (err: unknown) {
    // 退款 + 归还免费额度 + 写失败调用日志（统一实现，不再手写）
    const errorMessage = await run.fail(err, { nodeLabel: '图片生成', request: requestDetail })

    // 生成记录仍由本路由负责：它承载业务字段（prompt/尺寸/过期时间），属于业务侧职责
    await prisma.imageGenerationRecord.create({
      data: {
        userId: authUser.userId,
        modelId: run.model.id,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt || null,
        width: actualWidth ?? null,
        height: actualHeight ?? null,
        imageUrl: '',
        costPoints: chargedPoints,
        status: MEDIA_RECORD_STATUS.FAILED,
        // 与扣费流水同一个事务号，便于「这条记录对应哪笔扣分」直接 join
        runId: run.runId,
        errorMessage,
        expiresAt,
      },
    }).catch((e) => console.error('[image/generate] 写失败记录出错:', e))

    throw new ApiHandlerError(errorMessage, 500)
  }

  const record = await prisma.imageGenerationRecord.create({
    data: {
      userId: authUser.userId,
      modelId: run.model.id,
      prompt: prompt.trim(),
      negativePrompt: negativePrompt || null,
      width: actualWidth ?? null,
      height: actualHeight ?? null,
      imageUrl,
      costPoints: chargedPoints,
      status: MEDIA_RECORD_STATUS.SUCCESS,
      runId: run.runId,
      expiresAt,
    },
  })

  // 归集到素材库（source=generated），供"素材库"页展示生成的图片。
  //
  // 只归集**我们自己托管的**结果：默认不转存时 imageUrl 是上游临时外链，
  // 我们既没有文件也管不了它何时失效 —— 写进 user_assets 只会造出
  // 「记录在、图打不开、还永远清不掉」的死条目（生产库已有一条这样的脏数据）。
  if (isOwnAssetUrl(imageUrl)) {
    await prisma.userAsset.create({
      data: {
        userId: authUser.userId,
        type: 'image',
        url: imageUrl,
        fileName: prompt.trim().slice(0, 50) || '生成图片',
        mime: 'image/*',
        source: 'generated',
      },
    }).catch(() => {})
  }

  // 成功调用日志（含耗时 / 请求响应详情）
  await run.settle({ nodeLabel: '图片生成', request: requestDetail, response: { imageUrl } })

  if (sessionId) {
    try {
      const session = await prisma.chatSession.findFirst({
        where: { id: sessionId, userId: authUser.userId },
      })
      if (session) {
        // 一次取号写两条（用户气泡 + 助手气泡）：seq 由同一事务分配，不会再撞号（Q-106）
        await appendChatMessages(prisma, session.id, [
          { role: 'user', content: prompt.trim(), meta: { modelId: run.model.id, modelName: run.model.name } },
          {
            role: 'assistant',
            content: '已生成图片',
            mediaType: 'image',
            mediaUrls: [imageUrl],
            meta: { modelId: run.model.id, modelName: run.model.name, cost: chargedPoints, prompt: prompt.trim() },
          },
        ], { modelId: run.model.id })
      }
    } catch (err) {
      console.error('Image session persist error (non-fatal):', err)
    }
  }

  return success({ imageUrl, recordId: record.id }, '生成成功')
})
