import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { queryAudioStatus } from '@/lib/media-provider'
import { refundPoints } from '@/lib/billing/wallet'
import { releaseFreeQuota } from '@/lib/free-quota'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { settleTaskLogByTaskId, updateTaskProgress } from '@/lib/task-log'

// 轮询音频任务状态：更新记录，FAILED 时退款积分（扣积分计价）
export const GET = apiHandler<{ recordId: string }>(
  async (_request: NextRequest, { params }) => {
    const authUser = await requireAuth(_request)
    const { recordId } = await params
    const prisma = await getPrisma()

    const record = await prisma.audioGenerationRecord.findFirst({
      where: { id: recordId, userId: authUser.userId },
      include: { model: { include: { provider: true } } },
    })

    if (!record) {
      throw new ApiHandlerError('音频任务不存在', 404)
    }

    if (record.status === 'SUCCESS') {
      return { recordId, status: 'SUCCESS', audioUrl: record.audioUrl }
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

    const status = await queryAudioStatus(
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        adapterId: provider.adapterId,
        configJson: provider.configJson as Record<string, unknown> | null,
      },
      taskId,
      typeof meta.pollPath === 'string' ? meta.pollPath : undefined
    )

    if (status.status === 'SUCCESS' && status.audioUrl) {
      await prisma.audioGenerationRecord.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', audioUrl: status.audioUrl },
      })
      // 回写 202 调用日志 → 后台「任务型调用」看到真实终态
      await settleTaskLogByTaskId(taskId, { status: 'SUCCESS', url: status.audioUrl })
      return { recordId, status: 'SUCCESS', audioUrl: status.audioUrl }
    }

    if (status.status === 'FAILED') {
      const failMeta = (record.meta as Record<string, unknown> | null) || {}
      const costPoints = record.costPoints || 0
      // 本次是「用了每日免费额度」才 0 积分：失败要归还额度
      const usedFreeQuota = failMeta.freeQuota === true
      // 原子认领 + 同事务退款：并发轮询只有一方能 PENDING→FAILED
      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.audioGenerationRecord.updateMany({
            where: { id: record.id, status: 'PENDING' },
            data: { status: 'FAILED', errorMessage: status.error || '音频生成失败', meta: { ...failMeta, refunded: true } },
          })
          if (claimed.count === 0) return // 已被并发轮询认领
          if (costPoints > 0) {
            await refundPoints({ userId: authUser.userId, amount: costPoints, description: `音频生成失败退款：${record.model?.name || ''}`, tx })
          }
        })
        // 免费额度归还放在事务外（releaseFreeQuota 自开事务；额度是次数不是钱）
        if (usedFreeQuota && record.modelId) {
          await releaseFreeQuota(record.modelId, authUser.userId)
        }
      } catch (e) {
        console.error('音频失败退款事务失败(下轮轮询将重试):', e)
      }
      await settleTaskLogByTaskId(taskId, { status: 'FAILED', error: status.error || '音频生成失败' })
      return { recordId, status: 'FAILED', error: status.error || '音频生成失败' }
    }

    if (status.progress) await updateTaskProgress(taskId, status.progress)
    return { recordId, status: 'PENDING' }
  }
)
