import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'

/**
 * 成果提取：从一条 CanvasRun 的 seedOutputs 里，把「成果节点」产出的媒体 URL 抽出来。
 *
 * 为什么不在前端做：前端拿到的是整包 JSON（含上传图、裁切中间产物等），
 * 每个页面各自解析一遍必然漂移；这里统一按 resultNodeIds 提取，
 * 并按常见端口（imageUrl / images / videoUrl / videoUrls / audioUrl / audioUrls）归类。
 */
import { extractCanvasResults as extractResults } from '@/lib/recoverable-media'

/** 僵死判定：RUNNING 超过 30 分钟没有 updatedAt 更新 → 视作失败（服务器重启/崩溃遗留） */
const STALE_RUN_MS = 30 * 60 * 1000

/**
 * 本人最近的任务列表（工具页「刷新后恢复成果区」的数据源）。
 *
 * 只返回当前用户自己的 run；surface / surfaceId 用于把「工具页要恢复哪些任务」
 * 的范围收窄到「这个工具派发的 + 成果区批量操作派发的」。
 */
export const GET = apiHandler(
  async (request: NextRequest) => {
    const authUser = await requireAuth(request)
    const prisma = await getPrisma()
    const url = new URL(request.url)
    const { page, pageSize } = parsePagination(url, { maxPageSize: 50 })
    const surface = url.searchParams.get('surface') || undefined
    const surfaceId = url.searchParams.get('surfaceId') || undefined
    const status = url.searchParams.get('status') || undefined

    const where: Prisma.CanvasRunWhereInput = { userId: authUser.userId }
    if (surface) where.surface = surface
    if (surfaceId) where.surfaceId = surfaceId
    if (status) where.status = status

    // 僵死兜底：把「超时未更新的 RUNNING」一并视为过期（读时校正，不改库——
    // 写时校正需要定时任务，读时校正对前端恢复场景已足够）。
    const staleCutoff = new Date(Date.now() - STALE_RUN_MS)

    const [runs, total] = await Promise.all([
      prisma.canvasRun.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.canvasRun.count({ where }),
    ])

    return {
      items: runs.map((run) => {
        const isStale =
          run.status === 'RUNNING' &&
          run.updatedAt < staleCutoff
        const effectiveStatus = isStale ? 'FAILED' : run.status
        const resultNodeIds = Array.isArray(run.resultNodeIds) ? (run.resultNodeIds as string[]) : null
        return {
          id: run.id,
          status: effectiveStatus,
          stale: isStale,
          surface: run.surface,
          surfaceId: run.surfaceId,
          workflowName: run.workflowName,
          error: run.error,
          costPoints: run.costPoints,
          costBeans: run.costBeans,
          results: extractResults(run.seedOutputs, resultNodeIds),
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
        }
      }),
      total,
      page,
      pageSize,
    }
  }
)
