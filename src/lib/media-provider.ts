// Image generation provider proxy
// Adapter-driven thin wrapper. Custom vendors can override request/response
// handling in their ProviderAdapter code without touching this file.

import { invokeImage, invokeVideo, pollVideoStatus, invokeAudio, pollAudioStatus } from './provider-invoker'
import type { VideoParams, AudioParams } from './adapter-runtime'

export interface GenerateImageParams {
  baseUrl: string
  apiKey: string
  modelName: string
  prompt: string
  userId: string
  negativePrompt?: string
  width?: number
  height?: number
  referenceImages?: string[]
  adapterId?: string | null
  configJson?: Record<string, unknown> | null
  /** 模型配置的 metadata（含 rehost 转存开关） */
  modelMetadata?: Record<string, unknown> | null
}

export interface GenerateImageResult {
  imageUrl: string
}

export interface GenerateVideoParams extends VideoParams {
  baseUrl: string
  apiKey: string
  modelName: string
  prompt: string
  userId: string
  adapterId?: string | null
  configJson?: Record<string, unknown> | null
  /** 模型配置的 metadata（含 rehost 转存开关） */
  modelMetadata?: Record<string, unknown> | null
}

export interface GenerateVideoResult {
  videoUrl?: string
  taskId?: string
  pollPath?: string
}

export async function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const { baseUrl, apiKey, modelName, prompt, userId, adapterId, configJson, modelMetadata, ...videoParams } = params
  return invokeVideo(
    { baseUrl, apiKey, adapterId, configJson, metadata: modelMetadata ?? null },
    modelName,
    { ...videoParams, prompt },
    userId,
  )
}

export async function queryVideoStatus(
  provider: {
    baseUrl: string
    apiKey: string
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  taskId: string,
  pollPath?: string
) {
  return pollVideoStatus(provider, taskId, pollPath)
}

export interface GenerateAudioParams extends AudioParams {
  baseUrl: string
  apiKey: string
  modelName: string
  userId: string
  adapterId?: string | null
  configJson?: Record<string, unknown> | null
  /** 模型配置的 metadata（含 rehost 转存开关） */
  modelMetadata?: Record<string, unknown> | null
}

export interface GenerateAudioResult {
  audioUrl?: string
  taskId?: string
  pollPath?: string
}

export async function generateAudio(params: GenerateAudioParams): Promise<GenerateAudioResult> {
  const { baseUrl, apiKey, modelName, userId, adapterId, configJson, modelMetadata, ...audioParams } = params
  return invokeAudio(
    { baseUrl, apiKey, adapterId, configJson, metadata: modelMetadata ?? null },
    modelName,
    audioParams,
    userId,
  )
}

export async function queryAudioStatus(
  provider: {
    baseUrl: string
    apiKey: string
    adapterId?: string | null
    configJson?: Record<string, unknown> | null
  },
  taskId: string,
  pollPath?: string
) {
  return pollAudioStatus(provider, taskId, pollPath)
}

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const { baseUrl, apiKey, modelName, prompt, userId, negativePrompt, width, height, referenceImages, adapterId, configJson, modelMetadata } = params

  // 首次尝试
  try {
    return await invokeImage(
      { baseUrl, apiKey, adapterId, configJson, metadata: modelMetadata ?? null },
      modelName,
      { prompt, negativePrompt, width, height, referenceImages },
      userId,
    )
  } catch (err) {
    // 尺寸非法错误 → 解析合法尺寸列表,匹配最接近的,重试一次
    const sizes = extractSizesFromError(err)
    if (sizes.length > 0) {
      const matched = matchClosestSize(width || 1024, height || 1024, sizes)
      if (matched) {
        return await invokeImage(
          { baseUrl, apiKey, adapterId, configJson, metadata: modelMetadata ?? null },
          modelName,
          { prompt, negativePrompt, width: matched.w, height: matched.h, referenceImages },
          userId,
        )
      }
    }
    throw err
  }
}

// 从上游错误信息中解析合法尺寸列表
function extractSizesFromError(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err)
  // 匹配 "should be one of: 1024x1024, 1920x1080, ..." 或 "合法尺寸: 1024*1024, ..."
  const match = msg.match(/(?:should be one of|合法尺寸|supported sizes|one of)[:\s]*(.+)/i)
  if (!match) return []
  const list = match[1]
  // 提取 WxH 或 W*H 格式
  const sizes: string[] = []
  const re = /(\d+)\s*[x×*]\s*(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list)) !== null) {
    sizes.push(`${m[1]}x${m[2]}`)
  }
  return sizes
}

// 找最接近目标尺寸的预设：先按宽高比过滤（±10% 容差，保住用户选的比例），同比例内再按面积差最小
function matchClosestSize(width: number, height: number, sizes: string[]): { w: number; h: number } | null {
  if (sizes.length === 0) return null
  const targetArea = width * height
  const targetRatio = width / height
  type Cand = { sw: number; sh: number; diff: number }
  const cands: Cand[] = []
  for (const s of sizes) {
    const [sw, sh] = s.split('x').map(Number)
    if (!sw || !sh) continue
    cands.push({ sw, sh, diff: Math.abs(sw * sh - targetArea) })
  }
  if (cands.length === 0) return null
  const ratioOk = cands.filter((c) => Math.abs(c.sw / c.sh - targetRatio) / targetRatio <= 0.1)
  const pool = ratioOk.length > 0 ? ratioOk : cands // 没有同比例候选才退回全列表
  let best = pool[0]
  for (const c of pool) if (c.diff < best.diff) best = c
  return { w: best.sw, h: best.sh }
}
