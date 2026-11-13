import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { createGridGif } from '@/lib/image-processor'
import { ASSET_MAX_SIZE, saveAssetWithRecord } from '@/lib/asset-store'

/**
 * 宫格 GIF 调速：不调用模型、不重新生图，只拿原始宫格大图重新切帧编码。
 *
 * 为什么要单独一个路由：工具生成一次图很贵，用户调速度不该重跑生图。
 * 复用 `createGridGif`（与画布节点/工具执行同源），保证「调速后的帧/裁切/模式」
 * 与第一次合成完全一致。
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const body = await request.json()
  const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl.trim() : ''
  if (!imageUrl || !/^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(imageUrl)) {
    throw new ApiHandlerError('缺少可用的宫格大图地址', 400)
  }

  let result
  try {
    result = await createGridGif(imageUrl, {
      grid: body?.grid,
      delayMs: body?.delayMs,
      mode: body?.mode,
      frames: body?.frames,
      trimPercent: body?.trimPercent,
      maxSize: body?.maxSize,
      background: body?.background,
    })
  } catch (err) {
    throw new ApiHandlerError(err instanceof Error ? err.message : 'GIF 重新合成失败', 400)
  }

  if (result.gif.byteLength > ASSET_MAX_SIZE) {
    throw new ApiHandlerError('生成的 GIF 超过 10MB：请降低单帧最长边，或减少帧数', 400)
  }

  const prisma = await getPrisma()
  const saved = await saveAssetWithRecord(prisma, authUser.userId, result.gif, {
    mime: 'image/gif',
    type: 'image',
    source: 'generated',
  })

  return success({
    gifUrl: saved.url,
    frameCount: result.frameCount,
    width: result.width,
    height: result.height,
    delayMs: result.delayMs,
  }, 'GIF 已重新合成')
})
