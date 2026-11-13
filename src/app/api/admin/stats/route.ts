import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { isUsageError } from '@/lib/usage-log-state'

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 本地日期 YYYY-MM-DD（与 startOfDay 同一时区口径，避免标签与分桶边界错位） */
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })

  const prisma = await getPrisma()
  const now = new Date()
  const todayStart = startOfDay(now)
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const sevenDaysAgoStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgoStart = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000)

  const [
    totalUsers,
    activeUsersToday,
    pointsDistributedToday,
    pointsConsumedToday,
    apiCallsTodayTotal,
    apiCallsTodaySuccess,
    apiCallsTodayPending,
    recentUsageLogs,
    users30d,
    pointsLogs7d,
    usageLogs7d,
    imageRecords,
    videoRecords,
    cardKeys,
    canvasWorkflowCount,
    announcementCount,
    agentCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.apiUsageLog.findMany({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.pointsLog.aggregate({
      // category=null：只统计真实动过余额的流水。画布节点级记账（canvas-node）
      // 是预算池内部分摊，把它算进来会让「今日发放/消耗」翻倍。
      where: { createdAt: { gte: todayStart, lt: tomorrowStart }, amount: { gt: 0 }, category: null },
      _sum: { amount: true },
    }),
    prisma.pointsLog.aggregate({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart }, amount: { lt: 0 }, category: null },
      _sum: { amount: true },
    }),
    prisma.apiUsageLog.count({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
    }),
    prisma.apiUsageLog.count({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart }, statusCode: 200 },
    }),
    prisma.apiUsageLog.count({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart }, statusCode: 202 },
    }),
    prisma.apiUsageLog.findMany({
      where: { createdAt: { gte: sevenDaysAgoStart } },
      select: { modelId: true, statusCode: true, createdAt: true, tokensUsed: true },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: thirtyDaysAgoStart } },
      select: { createdAt: true },
    }),
    prisma.pointsLog.findMany({
      where: { createdAt: { gte: sevenDaysAgoStart }, category: null },
      select: { amount: true, type: true, createdAt: true },
    }),
    prisma.apiUsageLog.findMany({
      where: { createdAt: { gte: sevenDaysAgoStart } },
      select: { modelId: true, statusCode: true, pointsDeducted: true, beansDeducted: true, tokensUsed: true, outputKind: true },
    }),
    prisma.imageGenerationRecord.groupBy({
      by: ['status'],
      _count: true,
    }),
    prisma.videoGenerationRecord.groupBy({
      by: ['status'],
      _count: true,
    }),
    prisma.cardKey.groupBy({
      by: ['status'],
      _count: true,
    }),
    prisma.canvasWorkflow.count(),
    prisma.systemAnnouncement.count(),
    prisma.agent.count(),
  ])

  const recentPointsLogs = await prisma.pointsLog.findMany({
    // 运维面板的「最近积分流水」同样只列真实动账，避免看到成对的预扣/分摊记录
    where: { category: null },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { user: { select: { id: true, phone: true, nickname: true } } },
  })

  const modelCountMap = new Map<string, number>()
  for (const log of recentUsageLogs) {
    modelCountMap.set(log.modelId, (modelCountMap.get(log.modelId) || 0) + 1)
  }
  const topModelIds = Array.from(modelCountMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id)

  const topModelConfigs = topModelIds.length
    ? await prisma.modelConfig.findMany({
        where: { id: { in: topModelIds } },
        select: { id: true, name: true, type: true },
      })
    : []
  const modelInfoMap = new Map(topModelConfigs.map((m) => [m.id, m]))
  const topModels = topModelIds.map((id) => ({
    modelId: id,
    name: modelInfoMap.get(id)?.name || '未知模型',
    type: modelInfoMap.get(id)?.type || '',
    count: modelCountMap.get(id) || 0,
  }))

  const dailyUsage: { date: string; total: number; success: number; pending: number; error: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const dayLogs = recentUsageLogs.filter((l) => l.createdAt >= dayStart && l.createdAt < dayEnd)
    const success = dayLogs.filter((l) => l.statusCode === 200).length
    dailyUsage.push({
      date: localDateKey(dayStart),
      total: dayLogs.length,
      success,
      pending: dayLogs.filter((log) => log.statusCode === 202).length,
      error: dayLogs.filter((log) => isUsageError(log.statusCode)).length,
    })
  }

  const userGrowth: { date: string; count: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const dayStart = new Date(todayStart.getTime() - i * 86400000)
    const dayEnd = new Date(dayStart.getTime() + 86400000)
    userGrowth.push({ date: localDateKey(dayStart), count: users30d.filter((u) => u.createdAt >= dayStart && u.createdAt < dayEnd).length })
  }

  const pointsByType = new Map<string, number>()
  for (const pl of pointsLogs7d) pointsByType.set(pl.type, (pointsByType.get(pl.type) || 0) + pl.amount)
  const pointsBreakdown = Array.from(pointsByType.entries()).map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount)
  const pointsTrend: { date: string; income: number; expense: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(todayStart.getTime() - i * 86400000)
    const dayEnd = new Date(dayStart.getTime() + 86400000)
    const dayLogs = pointsLogs7d.filter((pl) => pl.createdAt >= dayStart && pl.createdAt < dayEnd)
    let income = 0, expense = 0
    for (const pl of dayLogs) { if (pl.amount > 0) income += pl.amount; else expense += Math.abs(pl.amount) }
    pointsTrend.push({ date: localDateKey(dayStart), income, expense })
  }

  const modelAgg = new Map<string, { calls: number; cost: number; tokens: number; errors: number }>()
  for (const l of usageLogs7d) {
    const a = modelAgg.get(l.modelId) || { calls: 0, cost: 0, tokens: 0, errors: 0 }
    a.calls++; a.cost += l.pointsDeducted || 0; a.tokens += l.tokensUsed || 0
    if (isUsageError(l.statusCode)) a.errors++
    modelAgg.set(l.modelId, a)
  }
  const modelIds = Array.from(modelAgg.keys())
  const modelConfigs = modelIds.length
    ? await prisma.modelConfig.findMany({ where: { id: { in: modelIds } }, select: { id: true, name: true, type: true } })
    : []
  const modelNameMap = new Map(modelConfigs.map((m) => [m.id, m]))
  const modelStats = Array.from(modelAgg.entries())
    .map(([modelId, a]) => ({
      modelId,
      name: modelNameMap.get(modelId)?.name || '未知模型',
      type: modelNameMap.get(modelId)?.type || '',
      calls: a.calls,
      cost: a.cost,
      tokens: a.tokens,
      errors: a.errors,
      errorRate: a.calls ? Math.round((a.errors / a.calls) * 100) : 0,
    }))
    .sort((x, y) => y.cost - x.cost)

  const genSummary = (records: { status: string; _count: number }[]) => {
    const total = records.reduce((s, r) => s + r._count, 0)
    const success = records.find((r) => r.status === 'SUCCESS')?._count || 0
    const failed = records.find((r) => r.status === 'FAILED')?._count || 0
    const pending = records.find((r) => r.status === 'PENDING')?._count || 0
    return { total, success, failed, pending, failedRate: total ? Math.round((failed / total) * 100) : 0, byStatus: records }
  }
  const [expiredImages, expiredVideos] = await Promise.all([
    prisma.imageGenerationRecord.count({ where: { expiresAt: { lt: now } } }),
    prisma.videoGenerationRecord.count({ where: { expiresAt: { lt: now } } }),
  ])
  // 生成统计的唯一真相源是 apiUsageLog（outputKind + statusCode）：
  // record 表只在成功时写、失败不留痕，拿它算成功率永远 100%（生产实测 image 全 SUCCESS 1536/0）。
  // record 表只保留「待清理」统计（expiresAt 已过的本站托管产物）。
  const kindAgg = (kind: string) => {
    const rows = usageLogs7d.filter((l) => l.outputKind === kind)
    const total = rows.length
    const success = rows.filter((l) => l.statusCode === 200).length
    // 202 = 异步任务已派发待轮询，计为「进行中」而非失败
    const pending = rows.filter((l) => l.statusCode === 202).length
    const failed = total - success
    const failedReal = failed - pending
    return { total, success, failed: failedReal, pending, failedRate: total ? Math.round((failedReal / total) * 100) : 0 }
  }
  const generationStats = {
    images: { ...kindAgg('image'), expired: expiredImages },
    // 视频单列「已消耗豆」：视频按豆计费、pointsDeducted 恒为 0，
    // 光看积分会在面板上显示「消耗 0」，与真实扣费（豆）对不上。
    videos: {
      ...kindAgg('video'),
      expired: expiredVideos,
      beansSpent: usageLogs7d.filter((l) => l.outputKind === 'video').reduce((s, l) => s + (l.beansDeducted || 0), 0),
    },
  }
  // LLM token 用量（近 7 天）：文本/视觉模型的 usage 由 charge-run 落进 tokensUsed。
  const llmTokenStats = {
    total: usageLogs7d.reduce((s, l) => s + (l.tokensUsed || 0), 0),
    calls: usageLogs7d.filter((l) => (l.tokensUsed || 0) > 0).length,
    today: recentUsageLogs.reduce((s, l) => s + (l.tokensUsed || 0), 0),
  }
  const cardKeyTotal = cardKeys.reduce((s, r) => s + r._count, 0)
  const cardKeyStats = { total: cardKeyTotal, byStatus: cardKeys.map((k) => ({ status: k.status, count: k._count })) }
  const contentStats = { canvasWorkflows: canvasWorkflowCount, announcements: announcementCount, agents: agentCount }

  return {
    totalUsers,
    activeUsersToday: activeUsersToday.length,
    pointsDistributedToday: pointsDistributedToday._sum.amount || 0,
    pointsConsumedToday: Math.abs(pointsConsumedToday._sum.amount || 0),
    apiCallsToday: {
      total: apiCallsTodayTotal,
      success: apiCallsTodaySuccess,
      pending: apiCallsTodayPending,
      error: apiCallsTodayTotal - apiCallsTodaySuccess - apiCallsTodayPending,
    },
    topModels,
    dailyUsage,
    userGrowth,
    pointsBreakdown,
    pointsTrend,
    modelStats,
    generationStats,
    llmTokenStats,
    cardKeyStats,
    contentStats,
    recentPointsLogs: recentPointsLogs.map((log) => ({
      id: log.id,
      userId: log.userId,
      user: log.user ? { id: log.user.id, phone: log.user.phone, nickname: log.user.nickname } : null,
      amount: log.amount,
      type: log.type,
      description: log.description,
      createdAt: log.createdAt.toISOString(),
    })),
  }
})
