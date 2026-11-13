import { Tag } from 'antd'

export type ModelPerfBadgeData = {
  avgLatencyMs: number
  latencyMeasured?: boolean
  successRate: number | null
  avgTps: number
  recentSuccessSeries?: Array<{ ts: number; success_rate: number; calls?: number; ok?: number }>
  hours?: number
}

const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

export function ModelPerfBadge({ perf, className = '' }: {
  perf: ModelPerfBadgeData | undefined
  className?: string
}) {
  if (!perf) return <span className="text-text-secondary">暂无数据</span>
  const rate = perf.successRate
  const hasRate = rate != null && Number.isFinite(rate) && rate >= 0 && rate <= 100
  const elapsed = perf.avgLatencyMs
  const latency = elapsed > 0 && Number.isFinite(elapsed)
    ? elapsed < 1000 ? decimal.format(elapsed) + ' ms' : decimal.format(elapsed / 1000) + ' 秒'
    : '—'
  const throughput = perf.avgTps > 0 && Number.isFinite(perf.avgTps) ? decimal.format(perf.avgTps) + ' token/s' : '—'
  const samples = (perf.recentSuccessSeries ?? []).filter(({ ts, success_rate }) =>
    Number.isFinite(ts) && Number.isFinite(success_rate) && success_rate >= 0 && success_rate <= 100)
  const caption = '过去 ' + (perf.hours ?? 24) + ' 小时'
  const fmtHour = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

  return <section className={'space-y-2 text-xs ' + className} aria-label={caption + '的模型表现'}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
      <Tag color={hasRate ? (rate >= 95 ? 'green' : rate >= 80 ? 'gold' : 'red') : 'default'}>
        成功率 {hasRate ? decimal.format(rate) + '%' : '—'}
      </Tag>
      <span>平均延迟 {latency}{elapsed > 0 && !perf.latencyMeasured ? '（估算）' : ''}</span>
      <span>吞吐 {throughput}</span>
    </div>
    {samples.length > 0 && <details>
      <summary className="cursor-pointer text-accent">{caption} · 逐时记录</summary>
      <ul className="mt-2 grid max-h-40 gap-1 overflow-y-auto">
        {[...samples].reverse().map(sample => <li key={sample.ts} className="flex justify-between gap-3 tabular-nums">
          <time dateTime={new Date(sample.ts * 1000).toISOString()}>{fmtHour.format(sample.ts * 1000)}</time>
          <span>{decimal.format(sample.success_rate)}%{sample.calls != null ? ' · ' + sample.calls + ' 次' : ''}</span>
        </li>)}
      </ul>
    </details>}
  </section>
}
