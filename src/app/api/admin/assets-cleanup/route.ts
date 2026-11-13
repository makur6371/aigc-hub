import { NextRequest } from 'next/server'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'
import { runMaintenance, maintenancePolicy } from '@/lib/maintenance'

// GET /api/admin/assets-cleanup - 查看可清理量（过期素材条数/容量）
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const { getPrisma } = await import('@/lib/prisma')
  const prisma = await getPrisma()
  const agg = await prisma.userAsset.aggregate({
    where: { expiresAt: { not: null, lte: new Date() } },
    _count: { _all: true },
    _sum: { size: true },
  })
  return success({
    expiredCount: agg._count._all,
    expiredBytes: agg._sum.size ?? 0,
    policy: maintenancePolicy(),
  })
})

// POST /api/admin/assets-cleanup - 手动跑一轮完整维护
// （过期素材 + 孤儿文件 + 运维日志 + 封面缓存；策略见 maintenancePolicy）
export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const r = await runMaintenance(true)
  const parts = [
    `过期素材 ${r.expiredAssets} 条`,
    `孤儿文件 ${r.orphanAssets} 个`,
    ...(r.expiredMediaRecords.image + r.expiredMediaRecords.video + r.expiredMediaRecords.audio > 0
      ? [`过期生成记录 ${r.expiredMediaRecords.image + r.expiredMediaRecords.video + r.expiredMediaRecords.audio} 条`]
      : []),
    `用量日志 ${r.apiUsageLogs} 条`,
    `运行记录 ${r.canvasRuns} 条`,
    `预扣账本 ${r.billingHolds} 条`,
    `封面缓存 ${r.coverFiles} 个`,
    `工具封面孤儿 ${r.orphanToolCovers} 个`,
    ...(r.relabeledLogs > 0 ? [`历史扣费文案归一 ${r.relabeledLogs} 条`] : []),
    ...(r.staleHolds > 0 ? [`僵死预扣退回 ${r.staleHolds} 笔`] : []),
  ]
  return success({ ...r, policy: maintenancePolicy() }, `维护完成：${parts.join('、')}`)
})
