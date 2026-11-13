import { getPrisma } from '@/lib/prisma'
import { toDetailJson } from '@/lib/usage-detail'
import { readUsageResponse } from '@/lib/usage-log-state'

export async function reconcileVideoUsageLogs(taskId?: string): Promise<boolean> {
  const prisma = await getPrisma()
  const logs = await prisma.apiUsageLog.findMany({
    where: { statusCode: 202, model: { type: 'VIDEO' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
  })
  const runIds = [...new Set(logs.map((log) => log.runId).filter((id): id is string => !!id))]
  if (!runIds.length) return false
  const [records, contextLogs] = await Promise.all([
    prisma.videoGenerationRecord.findMany({
      where: { runId: { in: runIds } },
      select: { id: true, runId: true, userId: true, modelId: true, status: true, videoUrl: true, errorMessage: true, meta: true },
    }),
    prisma.apiUsageLog.findMany({ where: { runId: { in: runIds } }, select: { id: true, runId: true, userId: true, modelId: true } }),
  ])
  let handled = false
  for (const log of logs) {
    const sameContext = records.filter((record) => record.runId === log.runId && record.userId === log.userId && record.modelId === log.modelId)
    if (!sameContext.length) continue
    const response = readUsageResponse(log.responseJson)
    const declaredIds = Array.isArray(response.recordIds) ? response.recordIds.filter((id): id is string => typeof id === 'string') : []
    const request = readUsageResponse(log.requestJson)
    const expectedCount = typeof request.count === 'number' ? request.count : 1
    const contextCount = contextLogs.filter((item) => item.runId === log.runId && item.userId === log.userId && item.modelId === log.modelId).length
    const upstreamId = (record: typeof sameContext[number]) => {
      const meta = record.meta as Record<string, unknown> | null
      return typeof meta?.taskId === 'string' ? meta.taskId : null
    }
    let candidates = declaredIds.length
      ? sameContext.filter((record) => declaredIds.includes(record.id))
      : contextCount === 1 && sameContext.length === expectedCount
        ? sameContext : log.taskId ? sameContext.filter((record) => upstreamId(record) === log.taskId) : []
    let ambiguous = false
    if (!candidates.length && !log.taskId && sameContext.every((record) => record.status === 'SUCCESS')) {
      candidates = sameContext
      ambiguous = true
    }
    if (declaredIds.length && candidates.length !== declaredIds.length) {
      if (taskId && candidates.some((record) => upstreamId(record) === taskId)) handled = true
      continue
    }
    if (!candidates.length) continue
    const taskIds = candidates.map(upstreamId).filter((id): id is string => !!id)
    if (taskId && !taskIds.includes(taskId)) continue
    handled = true
    const succeeded = candidates.filter((record) => record.status === 'SUCCESS').length
    const failed = candidates.filter((record) => record.status === 'FAILED').length
    const terminal = succeeded + failed === candidates.length
    const now = new Date()
    const urls = ambiguous ? [] : candidates.flatMap((record) => record.status === 'SUCCESS' && record.videoUrl ? [record.videoUrl] : [])
    await prisma.apiUsageLog.updateMany({
      where: { id: log.id, statusCode: 202 },
      data: {
        statusCode: terminal ? failed ? 500 : 200 : 202,
        taskId: log.taskId || (!ambiguous && taskIds.length ? taskIds[0] : null),
        errorMessage: terminal && failed ? candidates.find((record) => record.status === 'FAILED')?.errorMessage || '视频生成失败' : null,
        taskProgress: ambiguous ? '同批视频已完成；旧日志缺任务号，无法逐条对应'
          : terminal ? failed ? `成功 ${succeeded} / 失败 ${failed}` : '已完成'
            : `已完成 ${succeeded}/${candidates.length}，等待上游`,
        responseJson: toDetailJson({
          ...response, pending: !terminal, taskIds, recordIds: ambiguous ? undefined : candidates.map((record) => record.id),
          legacyAmbiguous: ambiguous, url: urls[0] || null, videoUrls: urls,
          submissionDurationMs: log.durationMs,
          ...(terminal ? { confirmedAt: now.toISOString(), confirmationDurationMs: ambiguous ? null : Math.max(0, now.getTime() - log.createdAt.getTime()) + (log.durationMs || 0) } : {}),
        }),
      },
    })
  }
  return handled
}
