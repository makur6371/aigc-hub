import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'
import { USAGE_FAILURE_WHERE, readUsageResponse } from '@/lib/usage-log-state'
import { reconcileVideoUsageLogs } from '@/lib/reconcile-video-logs'

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  await reconcileVideoUsageLogs().catch((error) => console.error('[usage-logs] 视频日志同步失败:', error))
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const status = url.searchParams.get('status') || undefined
  const modelId = url.searchParams.get('modelId') || undefined
  const userId = url.searchParams.get('userId') || undefined
  // 调用形态过滤：task=任务型（图/视频/音频），llm=会话型（大语言模型）。
  // 两者的关键字段不同（任务看 任务ID/进度；LLM 看 tokens），混一张表两边都不贴合。
  const form = url.searchParams.get('form') || undefined

  const where: Prisma.ApiUsageLogWhereInput = {}
  if (status === 'success') where.statusCode = 200
  else if (status === 'error') Object.assign(where, USAGE_FAILURE_WHERE)
  else if (status === 'pending') where.statusCode = 202
  if (modelId) where.modelId = modelId
  if (userId) where.userId = userId
  // 形态过滤走「模型类型」而非 outputKind：outputKind 在历史数据里可能为空，会漏掉行。
  if (form === 'llm') where.model = { type: { in: ['TEXT', 'VISION'] } }
  else if (form === 'task') where.model = { type: { notIn: ['TEXT', 'VISION'] } }

  const [items, total] = await Promise.all([
    prisma.apiUsageLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { id: true, phone: true, nickname: true } },
        model: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.apiUsageLog.count({ where }),
  ])

  return {
    items: items.map((log) => ({
      id: log.id,
      userId: log.userId,
      user: log.user
        ? { id: log.user.id, phone: log.user.phone, nickname: log.user.nickname }
        : null,
      modelId: log.modelId,
      model: log.model ? { id: log.model.id, name: log.model.name, type: log.model.type } : null,
      tokensUsed: log.tokensUsed,
      pointsDeducted: log.pointsDeducted,
      beansDeducted: log.beansDeducted,
      statusCode: log.statusCode,
      errorMessage: log.errorMessage,
      durationMs: log.durationMs,
      submissionDurationMs: log.taskId || log.statusCode === 202 || readUsageResponse(log.responseJson).submissionDurationMs != null ? log.durationMs : null,
      confirmationDurationMs: typeof readUsageResponse(log.responseJson).confirmationDurationMs === 'number' ? readUsageResponse(log.responseJson).confirmationDurationMs : null,
      source: log.source,
      nodeLabel: log.nodeLabel,
      runId: log.runId,
      outputKind: log.outputKind,
      taskId: log.taskId,
      taskProgress: log.taskProgress,
      requestJson: log.requestJson,
      responseJson: log.responseJson,
      createdAt: log.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  }
})
