import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'

// 模型性能监测：过去 24 小时的请求成功率（小时分桶）+ 平均延迟 + 吞吐（tokens/s）。
// 数据源：ApiUsageLog（每次模型调用都写一条，含 statusCode / tokensUsed / createdAt）。
// 说明：本站未逐条记录请求耗时，延迟按「同一小时内相邻调用间隔」估算，仅作趋势参考。

const HOURS = 24
const HOUR_MS = 3600 * 1000

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const url = new URL(request.url)
  const hours = Math.min(72, Math.max(6, Number(url.searchParams.get('hours')) || HOURS))
  const prisma = await getPrisma()

  const now = Date.now()
  // 对齐到整点，slot 23 = 当前这个「进行中」的小时
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS
  const windowStart = new Date(currentHourStart - (hours - 1) * HOUR_MS)

  const [models, logs] = await Promise.all([
    // 连停用模型一起返回：否则刚停用的模型在面板里凭空消失，看不出它之前的表现。
    // 排序在下面按「有调用优先」重排，停用的自然沉底。
    prisma.modelConfig.findMany({
      select: { id: true, name: true, type: true, isActive: true, provider: { select: { name: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.apiUsageLog.findMany({
      where: { createdAt: { gte: windowStart } },
      select: { modelId: true, statusCode: true, tokensUsed: true, durationMs: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  // 按模型分桶
  const byModel = new Map<string, { total: number; ok: number; tokens: number; durations: number[]; slots: Map<number, { total: number; ok: number }> }>()
  for (const l of logs) {
    if (l.statusCode === 202) continue
    let agg = byModel.get(l.modelId)
    if (!agg) {
      agg = { total: 0, ok: 0, tokens: 0, durations: [], slots: new Map() }
      byModel.set(l.modelId, agg)
    }
    const ok = l.statusCode === 200
    agg.total++
    if (ok) agg.ok++
    agg.tokens += l.tokensUsed ?? 0
    if (l.durationMs != null && l.durationMs > 0) agg.durations.push(l.durationMs)
    const slot = Math.floor(l.createdAt.getTime() / HOUR_MS) * HOUR_MS
    let s = agg.slots.get(slot)
    if (!s) { s = { total: 0, ok: 0 }; agg.slots.set(slot, s) }
    s.total++
    if (ok) s.ok++
  }

  const items = models.map((m) => {
    const agg = byModel.get(m.id)
    const total = agg?.total ?? 0
    const successRate = total > 0 ? Math.round(((agg!.ok / total) * 100) * 10) / 10 : null
    // 吞吐：窗口内总 token / 窗口内「有调用的小时数」（无调用的小时不计入，避免被拉低）
    const activeHours = new Set<number>()
    agg?.slots.forEach((_, k) => activeHours.add(k))
    const avgTps = agg && activeHours.size > 0 ? Math.round(agg.tokens / (activeHours.size * 3600)) : 0
    // 延迟估算：同一小时内相邻调用的平均间隔（毫秒）
    // 延迟：优先用真实记录的调用耗时（durationMs）取中位数。
    // 老数据没有 durationMs 时退回「相邻调用间隔」估算——那个值会被用户操作节奏污染
    // （实测出现过 76s），只作兜底，不再作为主口径。
    let latencyMs = 0
    const durations = agg?.durations ?? []
    if (durations.length > 0) {
      const sorted = [...durations].sort((a, b) => a - b)
      latencyMs = sorted[Math.floor(sorted.length / 2)]
    } else if (agg && total > 1) {
      const sorted = logs.filter((l) => l.modelId === m.id)
      const gaps: number[] = []
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i].createdAt.getTime() - sorted[i - 1].createdAt.getTime()
        if (d >= 1000 && d < HOUR_MS) gaps.push(d)
      }
      if (gaps.length > 0) {
        gaps.sort((a, b) => a - b)
        latencyMs = gaps[Math.floor(gaps.length / 2)]
      }
    }
    // 逐小时成功率序列（slot 对齐客户端当前整点）。
    // calls 一并返回：前端悬停每个格子要显示「时间 / 成功率 / 调用次数」。
    const series: Array<{ ts: number; success_rate: number; calls: number; ok: number }> = []
    for (let slot = 0; slot < hours; slot++) {
      const hourStart = currentHourStart - (hours - 1 - slot) * HOUR_MS
      const s = agg?.slots.get(hourStart)
      if (s && s.total > 0) {
        series.push({
          ts: Math.floor(hourStart / 1000),
          success_rate: Math.round((s.ok / s.total) * 1000) / 10,
          calls: s.total,
          ok: s.ok,
        })
      }
    }
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      isActive: m.isActive,
      provider: m.provider?.name ?? '',
      calls: total,
      successRate,
      avgLatencyMs: latencyMs,
      /** 延迟是实测还是估算（估算值仅供参考，前端会标注） */
      latencyMeasured: durations.length > 0,
      avgTps,
      recentSuccessSeries: series,
    }
  })

  // 排序：有调用的在前 → 启用的在前 → 调用量降序 → 名称
  items.sort((a, b) =>
    (b.calls > 0 ? 1 : 0) - (a.calls > 0 ? 1 : 0)
    || Number(b.isActive) - Number(a.isActive)
    || b.calls - a.calls
    || a.name.localeCompare(b.name),
  )

  return { hours, generatedAt: new Date().toISOString(), items }
})
