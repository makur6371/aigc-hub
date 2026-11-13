import { readdir, rm, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getPrisma } from '@/lib/prisma'
import { ASSET_DIR, ASSET_URL_PREFIX, fileOfAssetUrl } from '@/lib/asset-store'

/**
 * 素材清理：删除已过期素材（磁盘文件 + user_assets 记录）。
 *
 * 为什么需要：上游转存图、工具面板上传图会随使用量无限堆积，不清理会把磁盘占满。
 * 触发方式：惰性触发（用户访问素材相关接口时顺手跑一次，带节流），零运维、无需 cron。
 */
let lastRunAt = 0
const MIN_INTERVAL_MS = 10 * 60 * 1000 // 最多每 10 分钟跑一次，避免频繁扫盘

export interface CleanupResult {
  deletedRecords: number
  deletedFiles: number
  skipped: boolean
}

// 站内 URL → 磁盘绝对路径：收敛到 asset-store 的唯一实现（含越界守卫）
const localPathOf = fileOfAssetUrl

/** 删除过期素材。force=true 时忽略节流（后台手动触发用） */
export async function cleanupExpiredAssets(force = false): Promise<CleanupResult> {
  const now = Date.now()
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) {
    return { deletedRecords: 0, deletedFiles: 0, skipped: true }
  }
  lastRunAt = now

  const prisma = await getPrisma()
  const expired = await prisma.userAsset.findMany({
    where: { expiresAt: { not: null, lte: new Date() } },
    select: { id: true, url: true },
    take: 500,
  })
  if (expired.length === 0) return { deletedRecords: 0, deletedFiles: 0, skipped: false }

  let deletedFiles = 0
  for (const asset of expired) {
    const abs = localPathOf(asset.url)
    if (abs) {
      try {
        await rm(abs, { force: true })
        deletedFiles++
      } catch {
        // 文件可能已被删/不存在：忽略，继续删记录
      }
    }
  }
  const res = await prisma.userAsset.deleteMany({ where: { id: { in: expired.map((a) => a.id) } } })
  return { deletedRecords: res.count, deletedFiles, skipped: false }
}

/**
 * 回收孤儿文件：磁盘上存在但 user_assets 里没有记录的素材。
 * 上游转存（rehostExternalAsset）历史上不写表，会留下这类文件；这里兜底清理。
 * 只删「比孤儿宽限期更老」的文件，避免误删刚写入还没登记的素材。
 */
export async function cleanupOrphanAssets(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const prisma = await getPrisma()
  const rows = await prisma.userAsset.findMany({ select: { url: true } })
  const known = new Set(
    rows.map((r) => localPathOf(r.url)).filter((p): p is string => !!p),
  )

  const base = resolve(ASSET_DIR)
  let removed = 0
  const cutoff = Date.now() - olderThanMs

  async function walk(dir: string) {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (known.has(resolve(full))) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs < cutoff) {
          await rm(full, { force: true })
          removed++
        }
      } catch {
        // 忽略单个文件失败
      }
    }
  }

  await walk(base)
  return removed
}
