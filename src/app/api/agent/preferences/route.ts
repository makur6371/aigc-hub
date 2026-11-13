import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { normalizeExecuteMode, validateAgentPreferenceSpecs } from '@/lib/agent-preferences'

export const dynamic = 'force-dynamic'

/** 记忆文本上限：每轮都注入上下文，太长既贵又慢；这是「用户是谁」的画像，不是知识库 */
const MEMORY_MAX = 2000

/**
 * 归一化用户手填的记忆文本。
 *
 * 超长**截断而不是报错** —— 用户粘贴一大段时不该丢掉保存动作。
 * 空白串统一存 null（避免「存了个空格」这种脏数据让后续判断变复杂）。
 */
function normalizeMemory(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const t = String(raw).trim()
  return t ? t.slice(0, MEMORY_MAX) : null
}

export const GET = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth(request)
  const prisma = await getPrisma()
  const pref = await prisma.agentPreference.findUnique({ where: { userId: auth.userId } })
  return {
    imageModelId: pref?.imageModelId ?? null,
    videoModelId: pref?.videoModelId ?? null,
    audioModelId: pref?.audioModelId ?? null,
    imageRatio: pref?.imageRatio ?? null,
    imageTier: pref?.imageTier ?? null,
    imageQuality: pref?.imageQuality ?? null,
    videoRatio: pref?.videoRatio ?? null,
    videoResolution: pref?.videoResolution ?? null,
    videoDuration: pref?.videoDuration ?? null,
    memoryText: pref?.memoryText ?? null,
    executeMode: normalizeExecuteMode(pref?.executeMode),
  }
})

export const PUT = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth(request)
  const body = await request.json() as {
    imageModelId?: string | null; videoModelId?: string | null; audioModelId?: string | null
    imageRatio?: string | null; imageTier?: string | null; imageQuality?: string | null
    videoRatio?: string | null; videoResolution?: string | null; videoDuration?: number | null
    /** 用户手填的长期记忆 / 自我描述 */
    memoryText?: string | null
    /** 执行权限：auto = 全自动；confirm = 执行前确认 */
    executeMode?: string | null
  }

  // 校验模型类型匹配（图片偏好必须是 IMAGE 模型）
  const prisma = await getPrisma()
  const check = async (id: string | null | undefined, type: string, label: string) => {
    if (!id) return null
    const m = await prisma.modelConfig.findUnique({ where: { id }, select: { type: true, metadata: true } })
    if (!m) throw new ApiHandlerError(`${label}模型不存在`, 400)
    if (m.type !== type) throw new ApiHandlerError(`${label}模型类型不匹配`, 400)
    return { id, metadata: m.metadata }
  }
  const imageModel = await check(body.imageModelId, 'IMAGE', '生图')
  const videoModel = await check(body.videoModelId, 'VIDEO', '视频')
  const audioModel = await check(body.audioModelId, 'AUDIO', '音频')
  const imageModelId = imageModel?.id ?? null
  const videoModelId = videoModel?.id ?? null
  const audioModelId = audioModel?.id ?? null

  const specError = validateAgentPreferenceSpecs({
    imageModel,
    videoModel,
    imageRatio: body.imageRatio,
    imageTier: body.imageTier,
    videoRatio: body.videoRatio,
    videoResolution: body.videoResolution,
    videoDuration: typeof body.videoDuration === 'number' ? body.videoDuration : null,
  })
  if (specError) throw new ApiHandlerError(specError, 400)

  const memoryText = normalizeMemory(body.memoryText)
  // 未知值一律回落 auto（与读取侧同一函数，避免两边口径漂移）
  const executeMode = normalizeExecuteMode(body.executeMode)

  const pref = await prisma.agentPreference.upsert({
    where: { userId: auth.userId },
    update: {
      imageModelId: imageModelId ?? null,
      videoModelId: videoModelId ?? null,
      audioModelId: audioModelId ?? null,
      imageRatio: body.imageRatio ?? null,
      imageTier: body.imageTier ?? null,
      imageQuality: body.imageQuality ?? null,
      videoRatio: body.videoRatio ?? null,
      videoResolution: body.videoResolution ?? null,
      // 时长必须是有限正整数；NaN/Infinity 会让按秒计价算出 0 豆（与 video/generate 同一防线）
      videoDuration: typeof body.videoDuration === 'number' && Number.isFinite(body.videoDuration) && body.videoDuration > 0
        ? Math.round(body.videoDuration)
        : null,
      memoryText,
      executeMode,
    },
    create: {
      userId: auth.userId,
      imageModelId: imageModelId ?? null,
      videoModelId: videoModelId ?? null,
      audioModelId: audioModelId ?? null,
      imageRatio: body.imageRatio ?? null,
      imageTier: body.imageTier ?? null,
      imageQuality: body.imageQuality ?? null,
      videoRatio: body.videoRatio ?? null,
      videoResolution: body.videoResolution ?? null,
      videoDuration: typeof body.videoDuration === 'number' && Number.isFinite(body.videoDuration) && body.videoDuration > 0
        ? Math.round(body.videoDuration)
        : null,
      memoryText,
      executeMode,
    },
  })
  return pref
})
