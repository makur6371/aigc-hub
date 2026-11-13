import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { rm } from 'fs/promises'
import { fileOfAssetUrl } from '@/lib/asset-store'
import { recordUrlOf, type MediaKind } from '@/lib/media-kinds'

// ===== 用户生成记录：批量删除 / 清理失效 =====
//
// 三种媒体（图片/视频/音频）记录结构一致，共用这套逻辑，避免三份实现漂移。
// 删除时如果图片存在本站磁盘上，一并删文件——否则记录没了、文件还在，磁盘只增不减。

// MediaKind / URL 字段名统一由 media-kinds 注册表提供（见该文件注释），
// 三个 deleteMediaRecords/purgeExpired 分支不必再各自硬编码。
export type { MediaKind }


// 站内 URL → 磁盘绝对路径：收敛到 asset-store 的唯一实现（含越界守卫）
const localPathOf = fileOfAssetUrl

/** 删除记录 + 顺带删掉本站磁盘上的文件（外链跳过） */
async function deleteRecordsWithFiles(
  kind: MediaKind,
  rows: Array<{ id: string; url: string }>,
): Promise<number> {
  if (rows.length === 0) return 0
  const prisma = await getPrisma()
  // 先删文件（失败不阻断，最多留个孤儿文件由兜底清理回收）
  for (const r of rows) {
    const abs = localPathOf(r.url)
    if (abs) await rm(abs, { force: true }).catch(() => {})
  }
  // Prisma 的三种记录模型是独立类型，联合后方法签名不兼容 → 按类型分支调用
  const ids = rows.map((r) => r.id)
  const res =
    kind === 'image' ? await prisma.imageGenerationRecord.deleteMany({ where: { id: { in: ids } } })
    : kind === 'video' ? await prisma.videoGenerationRecord.deleteMany({ where: { id: { in: ids } } })
    : await prisma.audioGenerationRecord.deleteMany({ where: { id: { in: ids } } })
  return res.count
}

/**
 * 按 kind 查记录并统一取成 { id, url }。
 *
 * 三张记录表的 Prisma 模型是独立类型（字段名不同：imageUrl/videoUrl/audioUrl），
 * 联合后泛型不兼容，所以查询必须逐模态分支；但「取哪列当 url」收敛到 recordUrlOf，
 * 调用方不再感知字段名。以后加模态只动这里 + media-kinds 注册表。
 */
async function findRecordUrls(
  kind: MediaKind,
  where: { userId?: string; ids?: string[]; take?: number },
): Promise<Array<{ id: string; url: string }>> {
  const prisma = await getPrisma()
  const base = where.userId ? { userId: where.userId } : {}
  const take = where.take
  // PENDING 不进清理范围：异步退款流程依赖它（见 async-settle 铁律）。
  // 30 天 TTL 远超轮询窗口，正常路径 PENDING 早已落终态。
  const expiredWhere = { ...base, expiresAt: { lt: new Date() }, status: { not: 'PENDING' } }
  const rows = (kind === 'image'
    ? where.ids
      ? await prisma.imageGenerationRecord.findMany({ where: { ...base, id: { in: where.ids } }, select: { id: true, imageUrl: true } })
      : await prisma.imageGenerationRecord.findMany({ where: expiredWhere, select: { id: true, imageUrl: true }, take })
    : kind === 'video'
      ? where.ids
        ? await prisma.videoGenerationRecord.findMany({ where: { ...base, id: { in: where.ids } }, select: { id: true, videoUrl: true } })
        : await prisma.videoGenerationRecord.findMany({ where: expiredWhere, select: { id: true, videoUrl: true }, take })
      : where.ids
        ? await prisma.audioGenerationRecord.findMany({ where: { ...base, id: { in: where.ids } }, select: { id: true, audioUrl: true } })
        : await prisma.audioGenerationRecord.findMany({ where: expiredWhere, select: { id: true, audioUrl: true }, take })
  ) as Array<Record<string, string> & { id: string }>
  return rows.map((r) => ({ id: r.id, url: recordUrlOf(kind, r) }))
}

/**
 * 批量删除指定 id 的记录（仅限本人）。
 * body: { ids: string[] }
 */
export async function deleteMediaRecords(request: NextRequest, kind: MediaKind) {
  const authUser = await requireAuth(request)
  const body = await request.json().catch(() => null)
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown): x is string => typeof x === 'string') : []
  if (ids.length === 0) throw new ApiHandlerError('请选择要删除的记录', 400)
  if (ids.length > 500) throw new ApiHandlerError('一次最多删除 500 条', 400)

  const rows = await findRecordUrls(kind, { userId: authUser.userId, ids })
  const count = await deleteRecordsWithFiles(kind, rows)
  return { deleted: count }
}

/**
 * 清理失效记录（expiresAt 已过）。
 * body: { onlyExpired?: true } —— 目前只支持清失效，避免误删有效资产。
 */
export async function purgeExpiredMediaRecords(request: NextRequest, kind: MediaKind) {
  const authUser = await requireAuth(request)
  const rows = await findRecordUrls(kind, { userId: authUser.userId, take: 2000 })
  const count = await deleteRecordsWithFiles(kind, rows)
  return { deleted: count }
}

/**
 * 平台级清理：删除已过期生成记录及其本站文件（维护任务用，Q-D61 收口）。
 *
 * 为什么必须有：生成记录建表时都写了 30 天 expiresAt（画布产图 7 天），
 * 但此前只有用户手动「清理失效」才删——长期不登录的账号，过期记录与
 * 本站托管的产物文件会一直躺在磁盘上。生成历史的 UI 已是「过期即不可看」，
 * 删掉过期记录对用户可见面为零；本站文件删掉后由孤儿清理兜底残余。
 * PENDING 不能碰：异步退款流程依赖它（见 async-settle 的铁律）。
 */
export async function purgeExpiredMediaRecordsForPlatform(): Promise<{ image: number; video: number; audio: number }> {
  const result = { image: 0, video: 0, audio: 0 }
  for (const kind of ['image', 'video', 'audio'] as MediaKind[]) {
    try {
      const rows = await findRecordUrls(kind, { take: 2000 })
      result[kind] = await deleteRecordsWithFiles(kind, rows)
    } catch {
      // 单模态失败不影响其他模态；下轮维护重试
    }
  }
  return result
}
