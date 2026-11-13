import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import { join, resolve, extname } from 'path'
import { randomUUID } from 'crypto'

// ===== 工具封面存储（管理员上传）=====
//
// 为什么单独一套、不复用 user_assets：
//   1) 工具封面是**平台资产**，不属于任何用户，放 user_assets 会算进某个人的配额；
//   2) 它是长期资源（管理员上传一次长期用），而 user_assets 里大量条目是带 TTL 的临时素材，
//      混在一起会被过期清理误删；
//   3) 孤儿回收逻辑（cleanupOrphanAssets）按 user_assets 记录判断，封面不在其中会被当孤儿删掉。
//
// 目录：DATA_DIR/tool-covers（持久卷，容器重建不清空）
// URL：/api/tool-cover/<uuid>.<ext>

export const TOOL_COVER_DIR = process.env.TOOL_COVER_DIR || join(process.env.DATA_DIR || '/data', 'tool-covers')
export const TOOL_COVER_URL_PREFIX = '/api/tool-cover'

/** 封面大小上限：4:3 的展示图，2MB 足够；再大只是浪费磁盘和带宽 */
export const TOOL_COVER_MAX_SIZE = 2 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export const TOOL_COVER_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 保存一张工具封面，返回对外 URL */
export async function saveToolCover(buffer: Buffer, mime: string | undefined): Promise<string> {
  const ext = (mime && MIME_EXT[mime]) || '.png'
  const fileName = `${randomUUID()}${ext}`
  const dir = resolve(TOOL_COVER_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(resolve(dir, fileName), buffer)
  return `${TOOL_COVER_URL_PREFIX}/${fileName}`
}

/** 把 /api/tool-cover/xxx 映射到磁盘绝对路径；非本站封面地址返回 null */
export function toolCoverLocalPath(url: string): string | null {
  if (!url.startsWith(`${TOOL_COVER_URL_PREFIX}/`)) return null
  const rel = url.slice(TOOL_COVER_URL_PREFIX.length + 1)
  const base = resolve(TOOL_COVER_DIR)
  const abs = resolve(join(base, rel))
  // 防目录穿越
  if (abs !== base && !abs.startsWith(base + '/') && !abs.startsWith(base + '\\')) return null
  return abs
}

/**
 * 回收没被任何工具引用的封面文件（管理员换封面后留下的旧图）。
 * 只删「比宽限期更老」的，避免误删刚上传、DB 还没提交的封面。
 */
export async function cleanupOrphanToolCovers(referenced: Set<string>, olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const base = resolve(TOOL_COVER_DIR)
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return 0 // 目录不存在 → 没上传过封面
  }
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = join(base, entry.name)
    if (referenced.has(resolve(full))) continue
    try {
      const info = await stat(full)
      if (info.mtimeMs < cutoff) {
        await rm(full, { force: true })
        removed++
      }
    } catch { /* 单个文件失败忽略 */ }
  }
  return removed
}

/** 扩展名 → MIME（供静态服务路由用） */
export function toolCoverMime(file: string): string {
  return TOOL_COVER_MIME[extname(file).toLowerCase()] || 'application/octet-stream'
}
