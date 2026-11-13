import { NextRequest } from 'next/server'
import os from 'node:os'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { readRecentErrors } from '@/lib/error-sink'
import { checkRedisHealth } from '@/lib/redis'
import { USAGE_FAILURE_WHERE } from '@/lib/usage-log-state'

export const GET = apiHandler(async (request: NextRequest) => {
  // 纵深防御（Q-503）：proxy 已挡 /api/admin/*，但 65 个 admin 路由里唯独这里漏了
  // requireAuth —— 补齐口径，避免未来 proxy 规则调整时变成裸奔的管理接口。
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const mem = process.memoryUsage()

  const [
    dbOk, providers, modelCount, recentErrors, imageFailures, videoFailures, appErrors,
    openHolds, stuckRunningTasks, chargesWithoutRunId, orphanChargeRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT 1 AS ok').then(() => true).catch(() => false),
    prisma.apiProvider.findMany({
      select: { id: true, name: true, code: true, isActive: true, apiKey: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.modelConfig.count(),
    prisma.apiUsageLog.findMany({
      where: USAGE_FAILURE_WHERE,
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { model: { select: { name: true } } },
    }),
    prisma.imageGenerationRecord.findMany({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, errorMessage: true, createdAt: true },
    }),
    prisma.videoGenerationRecord.findMany({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, errorMessage: true, createdAt: true },
    }),
    // 进程级错误落盘（计划 3.2）：路由 500 / 裸 Error / 5xx 业务错误，重启后仍可回查
    readRecentErrors(50),
    // 资金健康（Q-D09②）：原先只能靠人跑 `audit-payments.cjs`，放进面板才会被日常看见
    prisma.billingHold.count({ where: { status: 'OPEN' } }),
    prisma.generationTask.count({ where: { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } }),
    prisma.pointsLog.count({
      where: { type: 'DEDUCTION', category: null, runId: null, createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    }),
    prisma.$queryRawUnsafe<{ cnt: number; points: number }[]>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(p.amount)), 0) AS points
       FROM points_logs p
       WHERE p.type = 'DEDUCTION' AND p.runId IS NOT NULL
         AND p.createdAt >= datetime('now', '-30 day') AND p.category IS NULL
         AND NOT EXISTS (SELECT 1 FROM api_usage_logs l WHERE l.runId = p.runId AND l.statusCode BETWEEN 200 AND 299)
         AND NOT EXISTS (SELECT 1 FROM billing_holds h WHERE h.runId = p.runId)`,
    ),
  ])

  const recentErrorsCombined = [
    ...recentErrors.map((e) => ({ kind: '调用', model: e.model?.name || '未知', statusCode: e.statusCode ?? 0, error: e.errorMessage, createdAt: e.createdAt.toISOString() })),
    ...imageFailures.map((e) => ({ kind: '生图', model: '', statusCode: 0, error: e.errorMessage, createdAt: e.createdAt.toISOString() })),
    ...videoFailures.map((e) => ({ kind: '视频', model: '', statusCode: 0, error: e.errorMessage, createdAt: e.createdAt.toISOString() })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)

  // 容器不可直接读 cgroup 限制（Alpine 下也无 /proc/1/cgroup 可靠解析），
  // 但「应用运行时长」用进程自己的 uptime 才准：os.uptime() 是**宿主机开机时长**，
  // 在服务器长期不重启时会显示成「几百天」，让人误以为应用很稳（其实是机器没重启过）。
  const processUptimeSec = Math.round(process.uptime())
  // Redis 健康（Q-D49）：它只服务「公众号验证码登录」，但**故障原本完全不可见**
  // （ioredis 的 error 事件在没有监听器时会被静默丢弃）。这里做成面板上的一项，
  // 让「微信登录失败」这类报障能第一眼看到是不是 Redis 挂了。
  const redisHealth = await checkRedisHealth()

  return {
    server: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      uptime: processUptimeSec,
      hostUptime: Math.round(os.uptime()),
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      dbOk,
      modelCount,
      redisOk: redisHealth.ok,
      redisError: redisHealth.error ?? null,
    },
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      isActive: p.isActive,
      hasKey: !!p.apiKey,
    })),
    recentErrors: recentErrorsCombined,
    appErrors,
    // 资金健康概览（30 天窗口）。孤儿扣费 = 有扣费流水但既无成功调用日志也无预扣账本，
    // 正常应长期贴近 0；持续变大说明「扣了钱但没人收口」的路径出现了。
    moneyHealth: {
      openHolds,
      stuckRunningTasks,
      chargesWithoutRunId30d: chargesWithoutRunId,
      orphanCharges30d: { count: Number(orphanChargeRows[0]?.cnt ?? 0), points: Number(orphanChargeRows[0]?.points ?? 0) },
    },
  }
})
