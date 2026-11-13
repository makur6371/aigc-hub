// 充值档位 → 能跑多少次 的换算。纯函数、无 DB 依赖，客户端交互与 SSR 共用同一份。
//
// 语义边界（重要）：平台当前**没有「套餐折扣」** —— RechargePackage 只决定
// 「花多少钱发多少积分/豆」，全站唯一的价格乘数是模型级 ModelConfig.discount。
// 所以这个页面回答的是「我充的这一档，在某个模型上能跑多少次」，
// 而不是「我这个套餐能打几折」。别把它做成后者，那会变成虚假宣传。
import { roundPoints } from '@/lib/pricing'
import type { PricingCatalogRow } from './model-pricing-catalog'

export type PackageTier = {
  id: string
  name: string
  kind: string
  priceCents: number
  points: number
  beans: number
  isSubscription: boolean
  durationDays: number | null
}

/**
 * 一个充值档位的「单位价格」—— 也就是用户说的套餐折扣本身。
 *
 * ===== 为什么它不是现成字段，而要从 priceCents / points 现算 =====
 * 平台的档位折扣从来不是一个 `discount` 列，而是**单位成本的自然差**：
 *   6 元档 60 积分  → ¥0.1000 / 积分
 *   100 元档 1200 积分 → ¥0.0833 / 积分   （比 6 元档便宜 17%）
 * 同一张模型价（4.5 积分）在两档折合出的价格因此不同：大额档真的更便宜。
 * 任何时候改套餐的发放量，单位价格自动跟着变 —— 单一数据源，不存在第二套折扣表。
 *
 * 币种分开算：积分与豆是两个独立额度（豆几乎只在订阅包/视频包发放），
 * 混成一个「每元多少额度」会把两种完全不同的东西摊平成一个假单价。
 */
export type PackageUnitPrice = {
  /** ¥ / 积分 */
  yuanPerPoint: number
  /** ¥ / 豆；该档不发豆时为 null */
  yuanPerBean: number | null
}

export function packageUnitPrice(pkg: PackageTier): PackageUnitPrice {
  const yuan = pkg.priceCents / 100
  return {
    // 额度为 0 时不返回 Infinity：Infinity 会一路乘进文案变成「¥Infinity」。
    // null = 该档不发这类额度，调用方据此说「本档不含积分」而不是编个单价。
    yuanPerPoint: pkg.points > 0 ? yuan / pkg.points : 0,
    yuanPerBean: pkg.beans > 0 ? yuan / pkg.beans : null,
  }
}

/** 同一批档位里，单位价格最低的那个（= 最划算的档）。用于标「最超值」。 */
export function bestValuePackageId(packages: PackageTier[]): string | null {
  let best: { id: string; rate: number } | null = null
  for (const p of packages) {
    const { yuanPerPoint } = packageUnitPrice(p)
    if (!(yuanPerPoint > 0)) continue
    if (!best || yuanPerPoint < best.rate) best = { id: p.id, rate: yuanPerPoint }
  }
  return best?.id ?? null
}

/**
 * 某档位相对最便宜档的溢价率：0.2 = 比最超值档贵 20%。
 *
 * 为什么要传**最超值档对象**而不是它的 id：
 * 档位单价是 priceCents / points，只看 id 拿不到「最超值那档发多少积分」，
 * 只能拿当前档自己的 points 去除 —— 算出来恒等于 0（自己跟自己比）。
 * 这个坑很隐蔽：函数不报错，只是永远返回 0，于是页面上「单价高 0%」。
 */
export function premiumVsBest(pkg: PackageTier, best: PackageTier | null): number | null {
  if (!best || pkg.id === best.id) return null
  const a = packageUnitPrice(pkg).yuanPerPoint
  const b = packageUnitPrice(best).yuanPerPoint
  if (!(a > 0) || !(b > 0)) return null
  return Math.round((a / b - 1) * 1000) / 1000
}

/** 积分单价 → 折合人民币，保留到「厘」，避免 0.0083 元被四舍五入成 0.01 */
export function yuanForPoints(yuanPerPoint: number, points: number): number {
  return Math.round(yuanPerPoint * points * 1000) / 1000
}

/** 生图：某档位单价下，这一档积分能出多少张图 */
export function estimateImageRuns(balancePoints: number, tierPrice: number): number {
  if (!(tierPrice > 0)) return 0
  return Math.floor(roundPoints(balancePoints) / tierPrice)
}

/** 视频：按时长算一次要多少豆，然后看能跑几次 */
export function estimateVideoRuns(
  balanceBeans: number,
  beansPerSecond: number,
  seconds: number
): { perRun: number; runs: number } {
  const perRun = roundPoints((beansPerSecond || 0) * Math.max(1, Math.ceil(seconds || 0)))
  if (!(perRun > 0)) return { perRun: 0, runs: 0 }
  return { perRun, runs: Math.floor(roundPoints(balanceBeans) / perRun) }
}

/** 取一个视频模型在指定分辨率档的每秒豆价；未单独定价回退基准价 */
export function videoBeansPerSecond(
  row: PricingCatalogRow,
  basePerSecond: number,
  resolution?: string | null
): number {
  if (resolution) {
    const want = String(resolution).toUpperCase()
    const hit = row.videoTiers.find((t) => t.resolution.toUpperCase() === want)
    if (hit) return hit.beansPerSecond
  }
  return basePerSecond
}
