// 异步任务兜底结算：把「用户已经不再轮询」的 PENDING 记录收口。
//
// 为什么必须单独做（真实漏钱路径）：
//   生视频 / 生音频是两段式的：提交时 chargeRun 预扣豆/积分、建 PENDING record；
//   退款只发生在「轮询阶段判出 FAILED」那一步。
//   于是：用户提交 → 关标签页/断网/息屏 → 上游最终 FAILED
//         → 没人轮询 → record 永远 PENDING → 钱永远不退回。
//
// 为什么既有兜底覆盖不到：
//   - canvasRun 超时收敛只管「画布任务卡在 RUNNING」
//   - billingHold 对账只管「预扣没结算」
//   - 这里的状态是「预扣已结算、但退款没发生」，两个兜底都不匹配。
//   结果就是余额少了、账面看着已扣，只有用户投诉才会发现。
//
// 本模块职责 = 复用与用户端轮询完全相同的「查上游 + 原子认领 + 退款」，
// 只把触发者从「前端轮询」换成「维护任务」。三条铁律：
//   1. 必须先查上游再决定，绝不能直接退款 —— 任务其实成功了呢？直接退就是白送。
//   2. 退款必须与状态流转同事务 + 原子认领（where status='PENDING'），否则会与
//      正在进行的用户端轮询重复退款。
//   3. 上游查不动（超时/鉴权失败）时不退款、保持 PENDING，盲目退钱 = 资损。
import { getPrisma } from '@/lib/prisma'
import { queryVideoStatus, queryAudioStatus } from '@/lib/media-provider'
import { refundBeans, refundPoints } from '@/lib/billing/wallet'
import { settleTaskLogByTaskId } from '@/lib/task-log'
import { releaseFreeQuota } from '@/lib/free-quota'

// 多久之后才开始接管轮询。设 0 无意义（用户正在页面上正常轮询时平白多打一次
// 上游查询）；20 分钟足够覆盖正常生成时长。
const TAKEOVER_AFTER_MS = 20 * 60 * 1000
// 单次维护最多处理多少条，避免一次跑太久拖慢其它清理任务
const BATCH = 20

export interface AsyncSettleResult {
  scanned: number
  succeeded: number
  failed: number
  stillRunning: number
  refundedBeans: number
  refundedPoints: number
}

export async function settleOrphanedAsyncTasks(now = new Date()): Promise<AsyncSettleResult> {
  const prisma = await getPrisma()
  const cutoff = new Date(now.getTime() - TAKEOVER_AFTER_MS)
  const result: AsyncSettleResult = {
    scanned: 0,
    succeeded: 0,
    failed: 0,
    stillRunning: 0,
    refundedBeans: 0,
    refundedPoints: 0,
  }

  // 只挑「有 taskId 的 PENDING」：没有 taskId 说明是同步任务（当场出结果或已退款），
  // 不该被这里接管。
  const videos = await prisma.videoGenerationRecord.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    take: BATCH,
    orderBy: { createdAt: 'asc' },
    include: { model: { include: { provider: true } } },
  })
  for (const rec of videos) {
    const meta = (rec.meta as Record<string, unknown> | null) ?? {}
    const taskId = typeof meta.taskId === 'string' ? meta.taskId : null
    if (!taskId) continue
    const provider = rec.model?.provider
    if (!provider || !provider.apiKey) continue
    result.scanned++
    try {
      const status = await queryVideoStatus(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          adapterId: provider.adapterId,
          configJson: provider.configJson as Record<string, unknown> | null,
        },
        taskId,
        typeof meta.pollPath === 'string' ? meta.pollPath : undefined,
      )
      if (status.status === 'SUCCESS' && status.videoUrl) {
        const claimed = await prisma.videoGenerationRecord.updateMany({
          where: { id: rec.id, status: 'PENDING' },
          data: { status: 'SUCCESS', videoUrl: status.videoUrl },
        })
        if (claimed.count === 0) continue
        await settleTaskLogByTaskId(taskId, { status: 'SUCCESS', url: status.videoUrl })
        result.succeeded++
        continue
      }
      if (status.status === 'FAILED') {
        const beansCost = rec.beansCost || 0
        const usedFreeQuota = meta.freeQuota === true
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.videoGenerationRecord.updateMany({
            where: { id: rec.id, status: 'PENDING' },
            data: {
              status: 'FAILED',
              errorMessage: status.error || '视频生成失败',
              meta: { ...meta, refunded: true },
            },
          })
          if (claimed.count === 0) return
          if (beansCost > 0) {
            await refundBeans({
              userId: rec.userId,
              amount: beansCost,
              description: `视频生成失败退款：${rec.model?.name || ''}`,
              tx,
            })
          }
        })
        if (usedFreeQuota && rec.modelId) {
          await releaseFreeQuota(rec.modelId, rec.userId).catch(() => {})
        }
        await settleTaskLogByTaskId(taskId, { status: 'FAILED', error: status.error || '视频生成失败' })
        result.failed++
        result.refundedBeans += beansCost
        continue
      }
      result.stillRunning++
    } catch (e) {
      console.error('[async-settle] 视频状态查询失败，保持 PENDING:', { recordId: rec.id, err: e })
    }
  }

  const audios = await prisma.audioGenerationRecord.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    take: BATCH,
    orderBy: { createdAt: 'asc' },
    include: { model: { include: { provider: true } } },
  })
  for (const rec of audios) {
    const meta = (rec.meta as Record<string, unknown> | null) ?? {}
    const taskId = typeof meta.taskId === 'string' ? meta.taskId : null
    if (!taskId) continue
    const provider = rec.model?.provider
    if (!provider || !provider.apiKey) continue
    result.scanned++
    try {
      const status = await queryAudioStatus(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          adapterId: provider.adapterId,
          configJson: provider.configJson as Record<string, unknown> | null,
        },
        taskId,
        typeof meta.pollPath === 'string' ? meta.pollPath : undefined,
      )
      if (status.status === 'SUCCESS' && status.audioUrl) {
        const claimed = await prisma.audioGenerationRecord.updateMany({
          where: { id: rec.id, status: 'PENDING' },
          data: { status: 'SUCCESS', audioUrl: status.audioUrl },
        })
        if (claimed.count === 0) continue
        await settleTaskLogByTaskId(taskId, { status: 'SUCCESS', url: status.audioUrl })
        result.succeeded++
        continue
      }
      if (status.status === 'FAILED') {
        const costPoints = rec.costPoints || 0
        const usedFreeQuota = meta.freeQuota === true
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.audioGenerationRecord.updateMany({
            where: { id: rec.id, status: 'PENDING' },
            data: {
              status: 'FAILED',
              errorMessage: status.error || '音频生成失败',
              meta: { ...meta, refunded: true },
            },
          })
          if (claimed.count === 0) return
          if (costPoints > 0) {
            await refundPoints({
              userId: rec.userId,
              amount: costPoints,
              description: `音频生成失败退款：${rec.model?.name || ''}`,
              tx,
            })
          }
        })
        if (usedFreeQuota && rec.modelId) {
          await releaseFreeQuota(rec.modelId, rec.userId).catch(() => {})
        }
        await settleTaskLogByTaskId(taskId, { status: 'FAILED', error: status.error || '音频生成失败' })
        result.failed++
        result.refundedPoints += costPoints
        continue
      }
      result.stillRunning++
    } catch (e) {
      console.error('[async-settle] 音频状态查询失败，保持 PENDING:', { recordId: rec.id, err: e })
    }
  }

  return result
}
