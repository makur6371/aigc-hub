import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'

/**
 * 本人最近的 Agent 任务列表 —— 前端「刷新/断线后认领结果」的数据源。
 *
 * ===== 为什么需要它 =====
 * 真实现象（2026-10-01 用户报告）：「刷新或中断后这边显示失败，但其实还在生成，
 * 只是已经拿不到结果了」。
 *
 * 与工具/画布不同：Agent **不写 CanvasRun**（生产 canvas_runs 的 surface 只有
 * canvas / tool / batch），结果只落在 generation_tasks.payload.subtasks 里。
 * 而前端此前**没有任何入口**去把「我已经跑完、但没被这一轮 SSE 拿到的结果」补回来 ——
 * 刷新一下，成果区就永远看不到那批图了。
 *
 * 本接口补齐这个入口：把「已完成任务的产出」交给前端认领。
 */

/** 僵死判定：RUNNING 超过 30 分钟没有更新 → 视作失败（与 canvas/runs 同一口径）。
 *  进程重启 / 断线遗留的 RUNNING 永远不会自己结束，读时校正比等定时任务更实际。 */
const STALE_RUN_MS = 30 * 60 * 1000

import { extractAgentResults as extractResults } from '@/lib/recoverable-media'

export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50 })
  const sessionId = url.searchParams.get('sessionId') || undefined

  const where = { userId: authUser.userId, taskType: 'agent', ...(sessionId ? { sessionId } : {}) }

  const [tasks, total] = await Promise.all([
    prisma.generationTask.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.generationTask.count({ where }),
  ])

  // 任务状态一览（含**在跑**的）。
  //
  // 为什么把 RUNNING 也返回（Q-D47）：原先这里把在跑的任务**整个过滤掉**，
  // 注释写着「运行中的占位由当轮 SSE 负责；断线后由下一次轮询/重连接住」——
  // 但**那个「下一次轮询」从来不存在**：前端只在挂载时取一次，且只认领 SUCCEEDED。
  // 于是「刷新时任务还在跑」这个场景里，客户端**根本不知道有任务在跑**，自然也不会等它。
  //
  // 现在：在跑的任务也返回（status='RUNNING'），前端据此**持续轮询到终态**，
  // 跑完就把成果认领回来 —— 注释里承诺的那半句终于兑现了。
  // 认领本身仍然只认 status==='SUCCEEDED' 且有 results 的，所以**在跑的任务不会被误认领**。
  const staleCutoff = new Date(Date.now() - STALE_RUN_MS)

  return {
    items: tasks
      .map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        // 僵死的（RUNNING 超过 30 分钟没更新）按失败给，不误导用户继续等；
        // 还在跑的如实给 RUNNING，让前端知道「还有活儿，要继续轮询」。
        status: t.status === 'RUNNING' && t.updatedAt < staleCutoff ? 'FAILED' : t.status,
        stale: t.status === 'RUNNING' && t.updatedAt < staleCutoff,
        costPoints: t.costPoints,
        costBeans: t.costBeans,
        error: t.error,
        results: extractResults((t.payload as { subtasks?: unknown } | null)?.subtasks),
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    total,
    page,
    pageSize,
  }
})
