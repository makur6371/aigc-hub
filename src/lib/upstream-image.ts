/**
 * 上游参考图统一公网化入口（"1+N" 图床架构的后端收口点）
 *
 * 背景：画布链路和 Agent 链路各自实现了一套「把任意图片地址变成上游可读的公网 URL」
 * 逻辑，口径分散、行为不一致（画布内联 data URL，Agent 拼公网域名），出问题要修两处。
 * 本模块是**唯一实现**，所有业务链路共用。
 *
 * 架构（1+N）：
 *   "1" = 本站图床（/api/assets，TTL 自动回收磁盘）
 *   "N" = 上游专属上传（adapter 预留 uploadAsset 钩子，当前无实现者）
 *
 * 三类输入 → 三种处理：
 *   data:image/...  → 落盘本站图床 → 公网 URL（模型输入类，2h TTL）
 *   /api/asset/...  → 存活检查 → 拼公网域名（文件不在则中文报错）
 *   http(s)://...   → 原样透传（已是公网）
 */
import { stat, readFile } from 'node:fs/promises'
import { fileOfAssetUrl, saveAssetWithRecord } from './asset-store'
import { safeFetch } from './ssrf-guard'

const PUBLIC_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')
const PUBLIC_ORIGIN = new URL(PUBLIC_BASE_URL).origin

/** 站内素材过期后的统一文案（与画布链路同口径） */
export const EXPIRED_ASSET_MESSAGE =
  '参考图已过期：上传的素材只保留 2 小时，过期后会被自动清理。请重新上传图片后再试。'

/** 上游外链失效（临时链接过期 / 被删除）时的文案：与站内过期区分，指向"重新生成或转存" */
export const EXPIRED_UPSTREAM_MESSAGE =
  '引用的图片链接已失效（上游临时链接有效期短）。请改用最新生成的图，或开启该模型的「转存到本站」长期保留。'

// 内联 data URL 的体积上限：约 10MB 原图（base64 膨胀 ~33%），超限退回 URL 引用
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

/** 站内素材直读（Node 侧 fetch 相对路径必然失败）；不存在返回 null */
async function readLocalAsset(url: string): Promise<Buffer | null> {
  const abs = fileOfAssetUrl(url)
  if (!abs) return null
  try {
    return await readFile(abs)
  } catch {
    return null
  }
}

/** 站内素材文件是否还在磁盘上（TTL 过期后清理任务会删盘，快照里仍留旧路径） */
export async function isLocalAssetAlive(url: string): Promise<boolean> {
  if (!url.startsWith('/api/asset/') && !url.startsWith('/generated/')) return true
  const abs = fileOfAssetUrl(url)
  // 站内前缀但解析越界（路径穿越）：视为不可用，别去 stat 站外文件
  if (!abs) return false
  try {
    const info = await stat(abs)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * 单个图片地址 → 上游可读地址
 *
 * 三种行为（与画布原 toUpstreamImageUrl 一致，保持画布行为不回退）：
 *   data:       原样内联（多模态 LLM 支持）
 *   站内路径    读盘转 data URL（上游拉不到我们的相对路径）；
 *              超 10MB 或读不到 → 拼公网 URL / 中文报错
 *   公网        原样透传
 */
export async function toUpstreamImageUrl(
  value: string,
  log?: (msg: string) => void,
): Promise<string> {
  if (!value) return value
  if (value.startsWith('data:image/')) return value
  if (value.startsWith('/generated/') || value.startsWith('/api/asset/')) {
    const buf = await readLocalAsset(value)
    if (buf && buf.byteLength <= MAX_INLINE_IMAGE_BYTES) {
      const ext = value.slice(value.lastIndexOf('.'))
      const mime = MIME_BY_EXT[ext.toLowerCase()] || 'image/png'
      return `data:${mime};base64,${buf.toString('base64')}`
    }
    if (buf) log?.(`图片超过内联上限(${Math.round(buf.byteLength / 1024 / 1024)}MB)，退回 URL 引用`)
    if (!buf) throw new Error(EXPIRED_ASSET_MESSAGE)
    return `${PUBLIC_BASE_URL}${value}`
  }
  return value
}

/**
 * 音视频素材的「上游可读地址」—— 与图片**刻意不同**：只给公网 URL，永不内联 base64。
 *
 * 为什么不能复用 toUpstreamImageUrl：
 *   1) 它会把小文件读出来转成 `data:image/png;base64,...` —— 对视频是几 MB 的 MP4
 *      套着 image/png 的 MIME，上游要么拒收要么直接 413；
 *   2) MAX_INLINE_IMAGE_BYTES 是按图片体积定的，视频走同一条路等于把整段视频塞进 JSON body。
 * 音视频上游一律自己拉 URL，所以这里只做「站内相对路径 → 公网绝对地址」这一件事。
 */
export async function toUpstreamMediaUrl(
  value: string,
  log?: (msg: string) => void,
): Promise<string> {
  if (!value) return value
  if (value.startsWith('/generated/') || value.startsWith('/api/asset/')) {
    // 站内素材先确认文件还在：过期素材上游只会回 404，用户看不懂。
    if (!(await isLocalAssetAlive(value))) {
      log?.(EXPIRED_ASSET_MESSAGE)
      throw new Error(EXPIRED_ASSET_MESSAGE)
    }
    return `${PUBLIC_BASE_URL}${value}`
  }
  return value
}

/**
 * data:image URL 落盘为站内素材（source='canvas-upload'，2h TTL）。
 *
 * 必须**同时登记 user_assets**：TTL 与配额都只看库里的行，只落盘不登记
 * 会让这些临时中转图永远不被 2h 清理任务回收（只能等 24h 孤儿清理），
 * 也会绕过单用户配额。
 *
 * 落盘/登记失败时抛错（不返回 data URL）：调用方 publicizeReferenceImages 依赖
 * 「返回的一定是站内 URL」来判定成功 —— 返回 data URL 会一路透传给只认公网 URL 的
 * 上游，报出「invalid base64 image data」这种误导性错误。
 */
export async function persistDataUrl(dataUrl: string, userId: string): Promise<string> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return dataUrl
  const buffer = Buffer.from(m[2], 'base64')
  if (buffer.byteLength === 0) return dataUrl
  const { getPrisma } = await import('./prisma')
  const prisma = await getPrisma()
  const asset = await saveAssetWithRecord(prisma, userId, buffer, { mime: m[1], type: 'image', source: 'canvas-upload' })
  return asset.url
}

/** 批量：数组内 data:image 全部落地 */
export async function persistDataUrls(urls: string[], userId: string): Promise<string[]> {
  return Promise.all(urls.map((u) => persistDataUrl(u, userId)))
}

/** 持久化（素材留档）+ 转上游可读地址，两步合一 */
export async function persistForUpstream(value: string, userId: string, log?: (msg: string) => void): Promise<string> {
  return toUpstreamImageUrl(await persistDataUrl(value, userId), log)
}
/**
 * 生图模型参考图公网化（画布/Agent 生图链路专用）
 *
 * 与 toUpstreamImageUrl 的差异：生图上游不认 data URL，必须给公网地址
 * （远端 API 需要 fetch 图片，data URL 在 JSON 里只是无意义字符串）。
 */
export async function publicizeReferenceImages(
  values: string[] | undefined,
  userId: string,
): Promise<string[]> {
  if (!values || values.length === 0) return []
  const out: string[] = []
  for (const v of values) {
    if (v.startsWith('data:image/')) {
      const persisted = await persistDataUrl(v, userId)
      // 落盘失败时 persistDataUrl 会原样返回 data URL —— 绝不能把它交给上游：
      // 生图上游只认公网 URL，收到 data URL 会报晦涩的「invalid base64 image data」，
      // 把「本机落盘失败（磁盘/配额）」误显示成「参考图格式错误」。
      if (!persisted.startsWith('/api/asset/') && !persisted.startsWith('/generated/')) {
        throw new Error('参考图保存失败（服务器磁盘/配额原因），请重试或换一张图。')
      }
      out.push(`${PUBLIC_BASE_URL}${persisted}`)
    } else if (v.startsWith('/api/asset/') || v.startsWith('/generated/')) {
      if (!(await isLocalAssetAlive(v))) throw new Error(EXPIRED_ASSET_MESSAGE)
      out.push(`${PUBLIC_BASE_URL}${v}`)
    } else {
      out.push(v)
    }
  }
  return out
}

/**
 * 上游外链是否可访问。返回 true=可达、false=明确失效(4xx)、null=不确定(超时/网络问题/5xx)。
 *
 * 只在**需要**时调用（如排查/批量场景），**不要**放进每张参考图的热路径 ——
 * 每张一次网络探活会让多图请求显著变慢。默认不做探活，让上游自己报错。
 */
export async function isRemoteReachable(url: string): Promise<boolean | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    // HEAD 最省流量；部分 CDN 不支持 HEAD → 回退 GET（只读状态，不下载 body）
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => null)
    if (!res) return null
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: controller.signal }).catch(() => null)
    }
    clearTimeout(timer)
    if (!res) return null
    if (res.status >= 200 && res.status < 400) return true
    if (res.status >= 400 && res.status < 500) return false
    return null
  } catch {
    return null
  }
}

/** 上游参考图公网化的完整上下文（供 adapter N 层扩展） */
export interface PublicizeCtx {
  userId: string
}

/**
 * [预留钩子 - N 层]
 *
 * 当某家上游强制要求「先传到自家图床拿专属链接，再用链接请求」时，
 * 在该 adapter 里实现本钩子。当前无实现者（现有上游全部吃公网 URL / multipart）。
 */
export async function uploadToUpstreamAsset(
  _buffer: Buffer,
  _mime: string,
  _ctx: PublicizeCtx,
): Promise<string | null> {
  return null
}

export type VisionImageTransport = 'url' | 'base64' | 'auto'

function localVisionAssetPath(value: string): string | null {
  if (value.startsWith('/api/asset/') || value.startsWith('/generated/')) return value
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const { origin, pathname } = new URL(value)
    return origin === PUBLIC_ORIGIN && (pathname.startsWith('/api/asset/') || pathname.startsWith('/generated/'))
      ? pathname
      : null
  } catch {
    return null
  }
}

async function compactVisionImage(file: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const pipeline = sharp(file, { limitInputPixels: 48_000_000 })
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
  const jpeg = await pipeline.clone().jpeg({ quality: 82 }).toBuffer()
  return jpeg.byteLength <= 700 * 1024 ? jpeg : pipeline.jpeg({ quality: 68 }).toBuffer()
}

async function readExternalVisionImage(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return bytes > 0 ? Buffer.concat(chunks, bytes) : null
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

export async function prepareLlmReferenceImages(
  values: string[],
  mode: VisionImageTransport = 'auto',
  opts: { maxBytes?: number; userId?: string } = {},
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  let remainingBytes = 5 * 1024 * 1024
  const externalSignal = mode === 'base64' ? AbortSignal.timeout(8000) : undefined
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    if (value.startsWith('data:image/')) {
      const bytes = Math.ceil(value.length * 0.75)
      if (mode === 'url' || bytes > Math.min(maxBytes, remainingBytes)) {
        if (!opts.userId) throw new Error('请先上传参考图，再调用视觉模型')
        out.push(...await publicizeReferenceImages([value], opts.userId))
      } else {
        remainingBytes -= bytes
        out.push(value)
      }
      continue
    }

    const localPath = localVisionAssetPath(value)
    const byteLimit = Math.min(maxBytes, remainingBytes)
    const fallback = localPath && value === localPath ? `${PUBLIC_BASE_URL}${localPath}` : value
    let inlined: Buffer | null = null
    let mime = 'image/jpeg'
    if (localPath) {
      const file = fileOfAssetUrl(localPath)
      if (!file || !(await isLocalAssetAlive(localPath))) throw new Error(EXPIRED_ASSET_MESSAGE)
      if (mode !== 'url' && byteLimit > 0) inlined = await compactVisionImage(file).catch(() => null)
    } else if (mode === 'base64' && byteLimit > 0 && !externalSignal?.aborted && /^https?:\/\//i.test(value)) {
      try {
        const response = await safeFetch(value, { signal: externalSignal })
        const contentType = response.headers.get('content-type')?.split(';')[0] ?? ''
        if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
          mime = contentType
          inlined = await readExternalVisionImage(response, byteLimit)
        } else {
          await response.body?.cancel()
        }
      } catch {
        inlined = null
      }
    }
    if (inlined && inlined.byteLength <= byteLimit) {
      remainingBytes -= inlined.byteLength
      out.push(`data:${mime};base64,${inlined.toString('base64')}`)
    } else {
      out.push(fallback)
    }
  }
  return out
}
