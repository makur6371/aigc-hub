import { mkdir, writeFile } from 'fs/promises'
import { resolve, join } from 'path'
import { createHash } from 'crypto'
import type { PrismaClient } from '@prisma/client'

const ALLOWED_EXT: Record<string, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
  video: ['.mp4', '.webm', '.mov'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a'],
  file: ['.json', '.txt', '.md'],
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
}

export const ASSET_MAX_SIZE = 10 * 1024 * 1024 // 10MB

/** 单用户素材配额：防止有人无限上传把磁盘/数据库撑爆 */
export const ASSET_QUOTA = {
  /** 单用户素材总容量上限（含临时素材） */
  maxTotalBytes: 500 * 1024 * 1024, // 500MB
  /** 单用户素材条数上限 */
  maxCount: 2000,
}

export function detectAssetType(mime: string | undefined, fileName?: string): string | null {
  if (mime && MIME_EXT[mime]) {
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    return 'file'
  }
  if (fileName) {
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.')).trim()
    for (const [type, exts] of Object.entries(ALLOWED_EXT)) {
      if (exts.includes(ext)) return type
    }
  }
  return null
}

/**
 * 从文件头识别图片真实格式。
 *
 * 为什么需要：上游返回 b64 时，部分模型已经原生输出 GIF，但 provider-invoker
 * 过去一律按 `image/png` 落盘 → .gif 字节被存成 .png，浏览器只显示第一帧。
 * 这里只做「字节事实」判断，不依赖上游声明的 content-type。
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

/** 内容寻址文件名：同一用户、同一字节内容、同一扩展名只对应一个文件。 */
export function assetContentFileName(
  buffer: Buffer,
  opts: { mime?: string; fileName?: string; type?: string },
): string {
  const type = opts.type || detectAssetType(opts.mime, opts.fileName) || 'file'
  const ext = pickExt(opts.mime, opts.fileName, type)
  const digest = createHash('sha256').update(buffer).digest('hex')
  return `${digest}${ext}`
}

function pickExt(mime: string | undefined, fileName?: string, type?: string): string {
  if (mime && MIME_EXT[mime]) return MIME_EXT[mime]
  if (fileName) {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase().trim()
    // 只接受白名单扩展名：任取 `^\.[a-z0-9]+$` 会让 .html/.svg 之类落盘，
    // 配合静态服务可能被当成可执行内容（同源 XSS）。
    const allowed = Object.values(ALLOWED_EXT).flat()
    if (allowed.includes(ext)) return ext
  }
  if (type === 'video') return '.mp4'
  if (type === 'audio') return '.mp3'
  return '.png'
}

// 素材根目录：生产 ASSET_DIR(/data/assets 持久卷) 容器重建/升级不清空；本地 dev 默认 public/generated
// 对外 URL 一律 /api/asset/... 由 route handler 动态服务，不用 /generated/（Next standalone 只服务构建时 public 快照）
export const ASSET_DIR = process.env.ASSET_DIR || resolve(process.cwd(), 'public', 'generated')
export const ASSET_URL_PREFIX = '/api/asset'

/**
 * 素材保留策略（秒）。null = 永久保留。
 * 目的：素材不能无限堆积把磁盘占满——上游转存图是临时的，工具面板上传是「给模型看的输入」，
 * 都不是用户的长期资产，给它们设过期；用户主动保存/编辑产出的图才长期保留。
 */
export const ASSET_TTL_SECONDS: Record<string, number | null> = {
  /**
   * 上游结果图转存（后台「转存图片到本站」开关打开时走这里）。
   *
   * **必须长期保留**：这个开关的语义就是「链接过期后图片失效，开启后落盘长期可用」
   * （见后台开关的提示文案）。之前给 2 小时是错的 ——
   * 用户特意开了转存，结果 2 小时后图还是被清理任务删了，
   * 和「默认不转存」的失败表现一模一样，开关等于白开。
   *
   * 保留期取 30 天：既兑现「长期可用」，又不至于无限堆积。
   * 用户想真正永久保存，走「保存到我的素材」（source='upload'，永久）。
   */
  rehost: 30 * 24 * 60 * 60,
  'tool-drag': 7 * 24 * 60 * 60, // 工具页拖入成果区：7 天
  // 操作面板上传（作为模型输入）：只是「给上游拉一次图」的临时中转，
  // 生成完就没用了。设 2 小时足够覆盖排队/重试，又能避免大量用户上传把磁盘撑爆。
  tool: 2 * 60 * 60,
  'canvas-upload': 2 * 60 * 60, // 画布上传节点落盘：同上，临时中转
  // 画布节点内联上传（node-bodies 的「上传文件/音频」控件）：同样只是喂给上游的临时中转，
  // 生成完就没用了。漏配会导致 expiresAtFor 返回 null → 永久保留（Q-811 磁盘泄漏）。
  canvas: 2 * 60 * 60,
  'canvas-audio': 2 * 60 * 60,
  upload: null,               // 用户素材库主动上传：永久
  /**
   * 工作台编辑产出。
   *
   * 原设计是「用户主动保存的编辑结果 → 永久保留」，但这个前提已经不成立：
   * 新编辑器（Media Studio Pro）的产出是 **blob URL，留在浏览器**，不再上传；
   * 唯一会写这个来源的旧 `ImageEditor.tsx` 已无人 import（2026-09-16 被替换）。
   *
   * 改成 7 天：既让历史遗留（生产库 13 条 / 41.5MB，全是 09-17 旧代码跑出来的）
   * 被维护任务自动回收，也给「万一以后有别的路径又写进来」兜底，避免永久堆积。
   */
  workbench: 7 * 24 * 60 * 60,
  generated: null,            // 生成结果：永久
  workflow: null,
}

/** 按来源算过期时间；未配置的来源视为永久（返回 null） */
export function expiresAtFor(source: string | undefined): Date | null {
  const ttl = source ? ASSET_TTL_SECONDS[source] : undefined
  if (ttl == null) return null
  return new Date(Date.now() + ttl * 1000)
}

/**
 * 这个 URL 是不是「我们自己托管的素材」。
 *
 * 只有站内地址（`/api/asset/...`、`/generated/...`）才是我们真正持有文件的；
 * `https://` 外链是上游临时链接，我们既没有文件、也管不了它什么时候失效。
 *
 * 用途：`/api/image|video|audio/generate` 归集素材库前先判断 ——
 * 默认不转存时 `url` 是上游外链，写进 `user_assets` 只会造出
 * 「记录在、图打不开、还永远清不掉」的死条目（生产库已有一条）。
 */
export function isOwnAssetUrl(url: string): boolean {
  return url.startsWith(`${ASSET_URL_PREFIX}/`) || url.startsWith('/generated/')
}

/**
 * 站内素材 URL → 磁盘绝对路径；非站内地址或**越界路径**返回 null。
 *
 * 为什么不直接在调用点 join：`/api/asset/../../etc/passwd` 这类构造路径
 * 会让 join 逃出 ASSET_DIR，读文件 / stat / 删除都必须先过这道守卫。
 * 这是全项目唯一的站内路径解析实现（此前 asset-cleanup / user-media-records
 * 各有一份，upstream-image 那份漏了守卫）。
 */
export function fileOfAssetUrl(url: string): string | null {
  if (!url) return null
  const apiPrefix = `${ASSET_URL_PREFIX}/`
  const genPrefix = '/generated/'
  const prefix = url.startsWith(apiPrefix) ? apiPrefix : url.startsWith(genPrefix) ? genPrefix : null
  if (!prefix) return null
  const abs = resolve(join(ASSET_DIR, url.slice(prefix.length)))
  const base = resolve(ASSET_DIR)
  if (abs !== base && !abs.startsWith(base + '/') && !abs.startsWith(base + '\\')) return null
  return abs
}

/**
 * 落盘 + 登记 user_assets（一个动作，避免「只落盘不登记」导致 TTL/配额失效）。
 *
 * 为什么需要：saveAssetFile 只写文件，不写库；而清理任务只按 user_assets.expiresAt
 * 回收，配额也只统计 user_assets。漏登记的落盘文件既不受 TTL 约束、也不计入配额，
 * 只能等 24h 孤儿清理（Q-811 磁盘泄漏的同一个坑）。
 */
export async function saveAssetWithRecord(
  prisma: Pick<PrismaClient, 'userAsset'>,
  userId: string,
  buffer: Buffer,
  opts: { mime?: string; fileName?: string; type?: string; source?: string },
): Promise<{ id: string; url: string; type: string; size: number; mime: string | null; fileName: string | null; source: string; expiresAt: Date | null }> {
  const source = opts.source ?? 'upload'
  const saved = await saveAssetFile(userId, buffer, { ...opts, source })
  const expiresAt = expiresAtFor(source)
  const record = await prisma.userAsset.create({
    data: {
      userId,
      type: saved.type,
      url: saved.url,
      fileName: saved.fileName,
      mime: saved.mime,
      size: saved.size,
      source,
      expiresAt,
    },
  })
  return { ...saved, id: record.id, source, expiresAt }
}

// 落盘到 {ASSET_DIR}/{userId}/assets/{uuid}.{ext}，返回对外 URL
export async function saveAssetFile(
  userId: string,
  buffer: Buffer,
  opts: { mime?: string; fileName?: string; type?: string; source?: string }
): Promise<{ url: string; type: string; size: number; mime: string | null; fileName: string | null }> {
  const declaredType = opts.type || detectAssetType(opts.mime, opts.fileName) || 'file'
  // 字节事实优先：原生 GIF 可能被上游/调用方标成 image/png。
  // 只信声明会在落盘时把 GIF 存成 .png，浏览器只显示第一帧。
  const sniffed = (declaredType === 'image' || opts.mime?.startsWith('image/'))
    ? sniffImageMime(buffer)
    : null
  const type = sniffed ? 'image' : declaredType
  const mime = sniffed || opts.mime
  const fileName = assetContentFileName(buffer, { ...opts, mime, type })
  const dir = resolve(ASSET_DIR, userId, 'assets')
  const filePath = resolve(dir, fileName)

  await mkdir(dir, { recursive: true })
  // wx：已存在同内容文件时直接复用，不再重复写一份字节。
  try {
    await writeFile(filePath, buffer, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  return {
    url: `${ASSET_URL_PREFIX}/${userId}/assets/${fileName}`,
    type,
    size: buffer.byteLength,
    mime: mime || null,
    fileName,
  }
}
