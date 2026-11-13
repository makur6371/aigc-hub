// ===== 统一「产物视图」=====
//
// 一次调用（无论模型是 LLM 还是图/视频/音频）最终产出都是一个「产物」：
// 文本块，或一个图片/视频/音频 URL。上层（调用日志、成果区、素材列表）不该
// 再按「是不是图片」写死分支 —— 那样加了视频就会显示成「无图片」。
//
// 这里把「从一次调用的返回详情里解析出产物」收敛成一个函数，返回 { kind, url }，
// kind 为 null 表示识别不出媒体（多为文本调用），url 为媒体地址。
//
// 说明：`ApiUsageLog.responseJson` 里存的可能是本站归一化后的 { imageUrl }，
// 也可能是上游原始体（OpenAI 风格 { data: [{ url }] } / { video_url } / b64）。
// 这里对已知几种结构做兼容，取不到媒体就判定为文本产物。

import { kindFromUrl, type MediaKind } from '@/lib/media-kinds'

export interface OutputView {
  /** 媒体模态；null = 无媒体（文本产物，或失败调用） */
  kind: MediaKind | null
  /** 媒体地址（kind 非 null 时有值） */
  url: string | null
}

/** 从任意返回体里抓第一个可用的媒体 URL（覆盖本站归一化 + 上游原始两种结构） */
function pickMediaUrl(obj: Record<string, unknown>): string | null {
  // 本站归一化字段
  for (const field of ['imageUrl', 'videoUrl', 'audioUrl'] as const) {
    const v = obj[field]
    if (typeof v === 'string' && v) return v
  }
  // 本站多图数组字段（Agent / MCP 一次生成 N 张时写 imageUrls）
  if (Array.isArray(obj.imageUrls) && obj.imageUrls.length > 0) {
    const first = obj.imageUrls[0]
    if (typeof first === 'string' && first) return first
  }
  // 上游常见直出字段
  for (const field of ['url', 'video_url', 'audio_url', 'b64_json'] as const) {
    const v = obj[field]
    if (typeof v === 'string' && v) return v
  }
  // OpenAI 风格 data[]
  const data = obj.data
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>
    for (const field of ['url', 'video_url', 'audio_url', 'b64_json', 'imageUrl'] as const) {
      const v = first?.[field]
      if (typeof v === 'string' && v) return v
    }
  }
  return null
}

/**
 * 解析一次调用的产物。
 * @param responseJson 调用日志里的返回详情（脱敏 JSON 字符串）
 * @param resultKindOverride 已知结果模态时直接指定（如按模型 type 推断），优先于 URL 反推
 */
export function parseOutput(responseJson: string | null, resultKindOverride?: MediaKind | null): OutputView {
  if (resultKindOverride) {
    const url = responseJson ? safePickUrl(responseJson) : null
    return { kind: resultKindOverride, url }
  }
  if (!responseJson) return { kind: null, url: null }

  try {
    const obj = JSON.parse(responseJson) as Record<string, unknown>
    const url = pickMediaUrl(obj)
    if (url) {
      if (url.startsWith('data:')) return { kind: 'image', url } // data URL 默认按图片
      return { kind: kindFromUrl(url) ?? 'image', url }
    }
    // 结构不认识时兜底：从原始字符串抓第一个带媒体扩展名的 http 链接
    const m = responseJson.match(/https?:\/\/[^\s"'\\]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)/i)
    if (m) return { kind: kindFromUrl(m[0]) ?? 'image', url: m[0] }
    return { kind: null, url: null }
  } catch {
    const m = responseJson.match(/https?:\/\/[^\s"'\\]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)/i)
    if (m) return { kind: kindFromUrl(m[0]) ?? 'image', url: m[0] }
    return { kind: null, url: null }
  }
}

function safePickUrl(responseJson: string): string | null {
  try {
    const obj = JSON.parse(responseJson) as Record<string, unknown>
    return pickMediaUrl(obj)
  } catch {
    const m = responseJson.match(/https?:\/\/[^\s"'\\]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)/i)
    return m ? m[0] : null
  }
}
