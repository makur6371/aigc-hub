'use client'

// 模型价格页（内测）：价格表 + 按充值档位折合人民币的实时换算。
//
// 数据形状来自 @/lib/billing/model-pricing-catalog（服务端算好后传入），
// 换算逻辑来自 model-pricing-calc（纯函数）—— 页面不重复实现任何定价规则。
//
// ===== UI 第一原则：折合 ¥ 是主角 =====
// 用户来这页只有一个问题「这个模型我要花多少钱」。积分/豆是内部单位，
// 所以右侧的折合 ¥ 必须是全行最大数字；档位/时长/分辨率是可点选的**参数**，
// 点了右侧价格立刻变；而「能出几张 / 能跑几次」是佐证，收成一行小字。
import { useMemo, useState } from 'react'
import { roundPoints } from '@/lib/pricing'
import type { PricingCatalogRow } from '@/lib/billing/model-pricing-catalog'
import {
  estimateImageRuns,
  videoBeansPerSecond,
  packageUnitPrice,
  bestValuePackageId,
  premiumVsBest,
  yuanForPoints,

  type PackageTier,
} from '@/lib/billing/model-pricing-calc'

const TYPE_TABS = [
  { key: 'ALL', label: '全部' },
  { key: 'IMAGE', label: '生图' },
  { key: 'VIDEO', label: '视频' },
  { key: 'TEXT', label: '对话' },
  { key: 'VISION', label: '多模态' },
  { key: 'AUDIO', label: '音频' },
] as const

const SORT_TABS = [
  { key: 'default', label: '默认排序' },
  { key: 'yuanAsc', label: '折合 ¥ 低到高' },
  { key: 'yuanDesc', label: '折合 ¥ 高到低' },
] as const

/** 分组顺序：先给最常买的两类（生图/视频），对话类垫后 */
const GROUP_ORDER = ['IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'VISION']

const round2 = (n: number) => Math.round(n * 100) / 100

function fmt(n: number): string {
  return String(roundPoints(n))
}

/** 人民币展示：¥0.09 这种几分钱必须保留到厘，否则会被四舍五入成 ¥0.1 误导量级 */
function fmtYuan(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1) return `¥${n.toFixed(2)}`
  if (n >= 0.01) return `¥${n.toFixed(3)}`
  return `¥${n.toFixed(4)}`
}

function Badge({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'good' }) {
  const cls =
    tone === 'good'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-surface text-text-secondary border-border'
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap ${cls}`}>
      {children}
    </span>
  )
}

type VideoHint = { durations?: number[]; minDuration?: number | null; maxDuration?: number | null }

/** 该模型真实可选的时长（来自其自身 constraints），保证算出来的次数真能跑出来 */
function durationOptions(hint?: VideoHint): number[] {
  if (hint?.durations?.length) return [...hint.durations].sort((a, b) => a - b)
  const min = hint?.minDuration && hint.minDuration > 0 ? hint.minDuration : 3
  const max = hint?.maxDuration && hint.maxDuration > 0 ? hint.maxDuration : 15
  const opts = new Set<number>([min, max])
  for (const s of [3, 5, 10, 15, 30]) if (s >= min && s <= max) opts.add(s)
  return [...opts].sort((a, b) => a - b)
}

function MiniSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string | number
  options: { value: string | number; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-white px-1 py-0.5 text-[11px] text-foreground"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

export default function ModelPricingClient({
  rows,
  packages,
  videoHints,
  note,
}: {
  rows: PricingCatalogRow[]
  packages: PackageTier[]
  videoHints: Record<string, VideoHint>
  note: string
}) {
  const [type, setType] = useState<string>('ALL')
  const [sort, setSort] = useState<string>('default')
  const [pkgId, setPkgId] = useState<string>(packages[0]?.id ?? '')
  // 每行各自的参数选择（档位 / 时长 / 分辨率）集中在这里，
  // 这样「按 ¥ 排序」才能用用户当前实际看到的那一档来比较。
  const [tierSel, setTierSel] = useState<Record<string, string>>({})
  const [videoSel, setVideoSel] = useState<Record<string, { seconds: number; resolution: string }>>({})

  const pkg = packages.find((p) => p.id === pkgId) ?? packages[0]
  // 「最超值」按积分单位价格算；订阅包发 0 积分自然不参与，
  // 否则会算出「0 元/积分 = 最超值」这种荒谬结论。
  const bestId = useMemo(() => bestValuePackageId(packages), [packages])
  const bestPkg = useMemo(() => packages.find((p) => p.id === bestId) ?? null, [packages, bestId])
  const pointBalance = pkg?.points ?? 0
  const beanBalance = pkg?.beans ?? 0

  /** 某行当前展示的 ¥（排序用它，必须与用户眼睛看到的完全一致） */
  const yuanOf = (row: PricingCatalogRow): number => {
    const up = pkg ? packageUnitPrice(pkg) : null
    if (row.type === 'VIDEO') {
      if (!up?.yuanPerBean) return Number.MAX_SAFE_INTEGER
      const sel = videoSel[row.id]
      const beans =
        row.videoBasis === 'perCall'
          ? row.perCallBeans
          : round2(
              videoBeansPerSecond(row, row.beans ?? 0, sel?.resolution || null) *
                Math.max(1, sel?.seconds ?? durationOptions(videoHints[row.id])[0] ?? 5)
            )
      return yuanForPoints(up.yuanPerBean, beans)
    }
    if (!up?.yuanPerPoint) return Number.MAX_SAFE_INTEGER
    const priced = row.tiers.filter((t) => t.points > 0)
    const hit = priced.find((t) => t.tier === tierSel[row.id]) ?? priced[0]
    return yuanForPoints(up.yuanPerPoint, hit ? hit.points : (row.points ?? 0))
  }

  const filtered = useMemo(() => {
    let list = rows.filter((r) => (type === 'ALL' ? true : r.type === type))
    if (sort === 'yuanAsc') list = [...list].sort((a, b) => yuanOf(a) - yuanOf(b))
    else if (sort === 'yuanDesc') list = [...list].sort((a, b) => yuanOf(b) - yuanOf(a))
    return list
  }, [rows, type, sort, pkg, tierSel, videoSel, videoHints])

  /** 「全部」时按类型分组；筛到单一类型就不分组（标题是多余噪音） */
  const groups = useMemo(() => {
    if (type !== 'ALL') return [{ key: type, label: '', items: filtered }]
    return GROUP_ORDER.map((k) => ({
      key: k,
      label: filtered.find((r) => r.type === k)?.typeLabel ?? k,
      items: filtered.filter((r) => r.type === k),
    })).filter((g) => g.items.length > 0)
  }, [filtered, type])

  const renderRow = (row: PricingCatalogRow) => {
    const up = pkg ? packageUnitPrice(pkg) : null
    const pointUnit = up?.yuanPerPoint ?? 0
    const beanUnit = up?.yuanPerBean ?? null

    const pricedTiers = row.tiers.filter((t) => t.points > 0)
    const uniform = pricedTiers.length > 0 && pricedTiers.every((t) => t.points === pricedTiers[0].points)
    const isFree = row.type !== 'VIDEO' && pricedTiers.length === 0 && (row.points ?? 0) <= 0
    const activeTier = pricedTiers.find((t) => t.tier === tierSel[row.id]) ?? pricedTiers[0]
    const imagePoints = activeTier ? activeTier.points : (row.points ?? 0)
    const imageRuns = pointBalance > 0 ? estimateImageRuns(pointBalance, imagePoints) : 0

    const isVideo = row.type === 'VIDEO'
    const perCall = isVideo && row.videoBasis === 'perCall'
    const hint = videoHints[row.id]
    const sel = videoSel[row.id] ?? {
      seconds: durationOptions(hint)[Math.floor(durationOptions(hint).length / 2)] ?? 5,
      resolution: '',
    }
    const perSecond = videoBeansPerSecond(row, row.beans ?? 0, sel.resolution || null)
    const beansPerRun = perCall ? row.perCallBeans : round2(perSecond * Math.max(1, Math.ceil(sel.seconds || 0)))
    const videoRuns = beanBalance > 0 && beansPerRun > 0 ? Math.floor(round2(beanBalance) / beansPerRun) : 0
    const videoYuan = beanUnit != null && beanUnit > 0 ? yuanForPoints(beanUnit, beansPerRun) : null
    const imageYuan = pointUnit > 0 ? yuanForPoints(pointUnit, imagePoints) : null

    return (
      <li key={row.id} className="px-4 py-3 transition-colors hover:bg-accent-soft/60">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">{row.name}</span>
              <Badge>{row.typeLabel}</Badge>
              {row.badges.map((b) => (
                <Badge key={b} tone={b === '免费' || b === '促销' ? 'good' : 'plain'}>{b}</Badge>
              ))}
            </div>

            {/* 生图：档位做成可点选芯片，选哪个档右侧就显示哪个档的钱 */}
            {!isVideo && pricedTiers.length > 1 && !uniform && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {pricedTiers.map((t) => {
                  const on = activeTier?.tier === t.tier
                  return (
                    <button
                      key={t.tier}
                      type="button"
                      onClick={() => setTierSel((s) => ({ ...s, [row.id]: t.tier }))}
                      title={t.list > t.points ? `原价 ${t.list} 积分` : undefined}
                      className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                        on
                          ? 'border-accent bg-accent-light text-accent font-medium'
                          : 'border-border bg-white text-text-secondary hover:border-accent-ring'
                      }`}
                    >
                      {t.tier} {t.points} 积分
                    </button>
                  )
                })}
              </div>
            )}

            {/* 视频：时长与分辨率是价格输入，不是装饰 */}
            {isVideo && !perCall && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <MiniSelect
                  label="时长"
                  value={sel.seconds}
                  options={durationOptions(hint).map((s) => ({ value: s, label: `${s}s` }))}
                  onChange={(v) => setVideoSel((s) => ({ ...s, [row.id]: { ...sel, seconds: Number(v) } }))}
                />
                {row.videoTiers.length > 1 && (
                  <MiniSelect
                    label="分辨率"
                    value={sel.resolution}
                    options={[
                      { value: '', label: '默认' },
                      ...row.videoTiers.map((t) => ({ value: t.resolution, label: t.resolution })),
                    ]}
                    onChange={(v) => setVideoSel((s) => ({ ...s, [row.id]: { ...sel, resolution: v } }))}
                  />
                )}
              </div>
            )}

            {/* 附量佐证：不与价格争视觉 */}
            <div className="mt-1.5 text-[11px] text-text-muted">
              {isVideo ? (
                beanUnit == null ? (
                  // 右侧已经写了「本档不含豆」，这里再说一遍是纯噪音
                  <span>选择含豆的充值档位后可估算次数</span>
                ) : (
                  <span>
                    {videoRuns > 0 ? (
                      <>
                        约可跑 <span className="font-medium text-text-secondary">{videoRuns}</span> 次
                      </>
                    ) : (
                      // 视频单价高，200 豆常常只够跑 0~1 次。写「约可跑 0 次」
                      // 读起来像坏了；说「不足 1 次」才是准确且不吓人的表述。
                      <span>本档额度不足 1 次</span>
                    )}
                  </span>
                )
              ) : pointUnit <= 0 ? (
                <span>当前所选档位不含积分</span>
              ) : row.type === 'IMAGE' ? (
                <span>
                  约可出 <span className="font-medium text-text-secondary">{imageRuns}</span> 张
                </span>
              ) : (
                // 对话/多模态/音频不是「按张计价」，说「约可出 60 张」是错的
                <span>
                  约可调用 <span className="font-medium text-text-secondary">
                    {pointBalance > 0 ? Math.floor(round2(pointBalance / Math.max(0.01, imagePoints))) : 0}
                  </span>{' '}
                  次
                </span>
              )}
            </div>
          </div>

          {/* 右：折合 ¥ 主数字 —— 本页唯一需要第一眼看到的东西 */}
          <div className="shrink-0 text-right">
            {isFree ? (
              <>
                <div className="text-base font-semibold text-emerald-600">免费</div>
                <div className="mt-0.5 text-[11px] text-text-muted">不扣额度</div>
              </>
            ) : isVideo ? (
              beanUnit == null ? (
                <>
                  <div className="text-sm font-medium text-text-muted">本档不含豆</div>
                  <div className="mt-0.5 text-[11px] text-text-muted">{fmt(beansPerRun)} 豆 / 次</div>
                </>
              ) : (
                <>
                  <div className="text-base font-semibold text-foreground">{fmtYuan(videoYuan ?? 0)}</div>
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    / 次 · {fmt(beansPerRun)} 豆
                  </div>
                </>
              )
            ) : pointUnit <= 0 ? (
              <>
                <div className="text-sm font-medium text-text-muted">本档不含积分</div>
                <div className="mt-0.5 text-[11px] text-text-muted">{fmt(imagePoints)} 积分 / 次</div>
              </>
            ) : (
              <>
                <div className="text-base font-semibold text-foreground">{fmtYuan(imageYuan ?? 0)}</div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  / 次 · {fmt(imagePoints)} 积分
                </div>
              </>
            )}
          </div>
        </div>
      </li>
    )
  }

  return (
    <div className="space-y-5">
      {/* 内测标识：明确这不是最终对外价，避免被当成承诺传播 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent-border bg-accent-soft px-3 py-2">
        <Badge tone="good">内测中</Badge>
        <span className="text-[11px] text-text-secondary">{note}</span>
      </div>

      {/* 充值档位：单位价格是重点，它就是套餐折扣本身 */}
      <section className="rounded-lg border border-border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">选择你的充值档位</h2>
          <span className="text-[11px] text-text-muted">下方所有价格均按所选档位折算为人民币</span>
        </div>

        {packages.length === 0 ? (
          <p className="text-xs text-text-muted">充值档位尚未配置，以下仅展示积分单价。</p>
        ) : (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {packages.map((p) => {
              const active = p.id === pkg?.id
              const up = packageUnitPrice(p)
              const isBest = p.id === bestId
              const premium = premiumVsBest(p, bestPkg)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPkgId(p.id)}
                  aria-pressed={active}
                  className={`min-w-[9.5rem] shrink-0 rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? 'border-accent bg-accent-light ring-1 ring-accent-ring'
                      : 'border-border bg-white hover:border-accent-ring hover:bg-accent-soft'
                  }`}
                >
                  <div className="truncate text-xs font-medium text-foreground">{p.name}</div>
                  <div className={`mt-1 text-sm font-semibold ${active ? 'text-accent' : 'text-foreground'}`}>
                    {up.yuanPerPoint > 0 ? fmtYuan(up.yuanPerPoint) : '—'}
                    <span className="ml-0.5 text-[11px] font-normal text-text-muted">/ 积分</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    ¥{(p.priceCents / 100).toFixed(0)} · {fmt(p.points)} 积分
                    {p.beans > 0 ? ` · ${fmt(p.beans)} 豆` : ''}
                  </div>
                  <div className="mt-1">
                    {isBest ? (
                      <Badge tone="good">最超值</Badge>
                    ) : premium != null && premium > 0 ? (
                      <span className="text-[11px] text-text-disabled">比最超值贵 {Math.round(premium * 100)}%</span>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {pkg && (
          <p className="mt-2.5 text-[11px] text-text-muted">
            {pkg.isSubscription
              ? `订阅包 ${pkg.durationDays ?? '—'} 天，期内发放 ${fmt(pkg.points)} 积分${
                  pkg.beans > 0 ? ` / ${fmt(pkg.beans)} 豆` : ''
                }；续费为延期，不重复发放已用额度。`
              : `发放 ${fmt(pointBalance)} 积分${
                  beanBalance > 0 ? ` 与 ${beanBalance} 豆` : ''
                }，可跨全部模型按需消耗。`}
          </p>
        )}
      </section>

      {/* 筛选 + 排序 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {TYPE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setType(t.key)}
              aria-pressed={type === t.key}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                type === t.key
                  ? 'bg-accent text-white'
                  : 'bg-white border border-border text-text-secondary hover:bg-accent-soft'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-md border border-border bg-white px-2 py-1 text-xs text-text-secondary"
        >
          {SORT_TABS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* 价格表 */}
      <section className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-foreground">
            模型价格表
            <span className="ml-1.5 text-xs font-normal text-text-muted">{filtered.length} 个模型</span>
          </h2>
          <span className="text-[11px] text-text-muted">点档位可切换价格口径</span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-text-muted">该分类下暂无模型</div>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              {g.label && (
                <div className="border-b border-border bg-surface px-4 py-1.5 text-[11px] font-medium text-text-muted">
                  {g.label} · {g.items.length}
                </div>
              )}
              <ul className="divide-y divide-border">{g.items.map(renderRow)}</ul>
            </div>
          ))
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1.5 text-xs font-semibold text-foreground">计价说明</h2>
        <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-text-muted">
          <li>折合 ¥ 按所选充值档位的单位价格计算；换档位后全表价格实时重算。</li>
          <li>积分用于对话、生图、音频；视频从独立的「豆」额度扣除，两者不通用。</li>
          <li>生图按所选清晰度档位计价；未单独定价的档位沿用 1K 参考价。</li>
          <li>视频按时长与分辨率计价，可能含起步价与按输入素材计费，详情见应用内结算提示。</li>
          <li>生成失败自动退还已扣额度；免费额度每日 0 点重置。</li>
        </ul>
      </section>
    </div>
  )
}
