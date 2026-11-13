import { getPrisma } from '@/lib/prisma'
import { toDetailJson } from '@/lib/usage-detail'
import { reconcileVideoUsageLogs } from '@/lib/reconcile-video-logs'

/**
 * 任务型调用的日志收口。
 *
 * ===== 它解决什么 =====
 * 任务型调用（生视频/生音频）分两段：
 *   1) 提交：`chargeRun.defer()` 写一条 statusCode=202（进行中）的调用日志，带 taskId；
 *   2) 轮询：`/api/video|audio/status/[recordId]` 拿到真实结果。
 *
 * 第 2 段此前只更新 VideoGenerationRecord，**不回头改那条 202 日志** ——
 * 于是后台「任务型调用」表里，任务永远停在「进行中」，哪怕早已成功或失败。
 * 本模块负责把最终结果回写到日志，让后台看到的是真实终态（对齐 New API 任务日志的语义）。
 *
 * 为什么按 taskId 而不是 runId 关联：任务型调用的发起方未必有 canvas run
 * （直连 /api/video/generate 就没有），而 taskId 是所有任务型调用都有的稳定标识。
 */
export async function settleTaskLogByTaskId(
  taskId: string,
  result: { status: 'SUCCESS' | 'FAILED'; url?: string | null; error?: string | null; progress?: string | null },
): Promise<void> {
  if (!taskId) return
  try {
    if (await reconcileVideoUsageLogs(taskId).catch(() => false)) return
    const prisma = await getPrisma()
    // 只改「还停在 202」的行：已经终态的不再回写（避免并发轮询互相覆盖）
    await prisma.apiUsageLog.updateMany({
      where: { taskId, statusCode: 202 },
      data: {
        statusCode: result.status === 'SUCCESS' ? 200 : 500,
        errorMessage: result.status === 'FAILED' ? (result.error ?? '任务失败').slice(0, 300) : null,
        taskProgress: result.status === 'SUCCESS' ? '已完成' : '失败',
        responseJson: toDetailJson(
          result.status === 'SUCCESS'
            ? { url: result.url ?? null, taskId, note: '异步任务已完成' }
            : { error: result.error ?? '任务失败', taskId },
        ),
      },
    })
  } catch (e) {
    // 日志回写失败绝不能影响退款/状态更新主流程
    console.error('[task-log] 回写任务日志失败:', e)
  }
}

/** 轮询途中回填进度（如「排队中 2/4」），不改变状态码。 */
export async function updateTaskProgress(taskId: string, progress: string): Promise<void> {
  if (!taskId || !progress) return
  try {
    const prisma = await getPrisma()
    await prisma.apiUsageLog.updateMany({
      where: { taskId, statusCode: 202 },
      data: { taskProgress: progress.slice(0, 200) },
    })
  } catch { /* 进度只是锦上添花，失败不影响主流程 */ }
}
