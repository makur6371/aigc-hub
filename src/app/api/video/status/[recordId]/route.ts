import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { queryVideoStatus } from '@/lib/media-provider'
import { refundBeans } from '@/lib/billing/wallet'
import { releaseFreeQuota } from '@/lib/free-quota'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { settleTaskLogByTaskId, updateTaskProgress } from '@/lib/task-log'

// 轮询视频任务状态：更新记录，FAILED 时退款豆
export const GET = apiHandler<{ recordId: string }>(
  async (_request: NextRequest, { params }) => {
    const authUser = await requireAuth(_request)
    const { recordId } = await params
    const prisma = await getPrisma()

    const record = await prisma.videoGenerationRecord.findFirst({
      where: { id: recordId, userId: authUser.userId },
      include: { model: { include: { provider: true } } },
    })

    if (!record) {
      throw new ApiHandlerError('视频任务不存在', 404)
    }

    if (record.status === 'SUCCESS') {
      return { recordId, status: 'SUCCESS', videoUrl: record.videoUrl }
    }
    if (record.status === 'FAILED') {
      return { recordId, status: 'FAILED', error: record.errorMessage }
    }

    const meta = (record.meta as Record<string, unknown> | null) || {}
    const taskId = typeof meta.taskId === 'string' ? meta.taskId : null

    if (!taskId) {
      return { recordId, status: 'PENDING' }
    }

    const provider = record.model?.provider
    if (!provider || !provider.apiKey) {
      return { recordId, status: 'PENDING' }
    }

    const status = await queryVideoStatus(
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        adapterId: provider.adapterId,
        configJson: provider.configJson as Record<string, unknown> | null,
      },
      taskId,
      typeof meta.pollPath === 'string' ? meta.pollPath : undefined
    )

    if (status.status === 'SUCCESS' && status.videoUrl) {
      await prisma.videoGenerationRecord.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', videoUrl: status.videoUrl },
      })
      // 回写那条 202 调用日志 → 后台「任务型调用」看到真实终态（否则永远停在「进行中」）
      await settleTaskLogByTaskId(taskId, { status: 'SUCCESS', url: status.videoUrl })
      return { recordId, status: 'SUCCESS', videoUrl: status.videoUrl }
    }

    if (status.status === 'FAILED') {
      const failMeta = (record.meta as Record<string, unknown> | null) || {}
      const beansCost = record.beansCost || 0
      // 本次是「用了每日免费额度」才 0 豆：失败要归还额度，否则用户白损失一次
      const usedFreeQuota = failMeta.freeQuota === true
      // 原子认领 + 同事务退款：并发轮询只有一方能 PENDING→FAILED；退款失败则整体回滚，下轮轮询可重试
      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.videoGenerationRecord.updateMany({
            where: { id: record.id, status: 'PENDING' },
            data: { status: 'FAILED', errorMessage: status.error || '视频生成失败', meta: { ...failMeta, refunded: true } },
          })
          if (claimed.count === 0) return // 已被并发轮询认领
          if (beansCost > 0) {
            await refundBeans({ userId: authUser.userId, amount: beansCost, description: `视频生成失败退款：${record.model?.name || ''}`, tx })
          }
        })
        // 免费额度归还放在事务外：releaseFreeQuota 自己开事务，
        // 且额度是「次数」不是钱，多退一次的代价远小于少退（用户投诉）
        if (usedFreeQuota && record.modelId) {
          await releaseFreeQuota(record.modelId, authUser.userId)
        }
      } catch (e) {
        console.error('视频失败退款事务失败(下轮轮询将重试):', e)
      }
      // 只有真正认领成功（PENDING→FAILED）才回写终态，避免并发轮询重复写
      await settleTaskLogByTaskId(taskId, { status: 'FAILED', error: status.error || '视频生成失败' })
      return { recordId, status: 'FAILED', error: status.error || '视频生成失败' }
    }

    // 仍在进行中：把上游进度回填到日志（如「排队中 2/4」）
    if (status.progress) await updateTaskProgress(taskId, status.progress)
    return { recordId, status: 'PENDING' }
  }
)
