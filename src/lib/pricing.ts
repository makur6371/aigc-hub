// ===== 积分计价 =====
// 积分支持小数（保留 2 位）：折扣后可能不足 1（如 6 积分 × 0.1 折 = 0.6）。
// 统一在出口处四舍五入到 2 位，避免浮点误差累积成 0.6000000000000001 这种脏数据。

/**
 * 把「可能来自 JSON 的任意值」规整为有限数，非法一律回落 `fallback`。
 *
 * 为什么必须统一：`Number('abc')` / `Number(undefined)` 都是 NaN，而 NaN 的比较
 * 全部为 false —— `NaN > 1000`、`NaN < 0` 都不成立，会**穿过所有校验**。
 * 实测过的后果：审核奖励传 NaN → `adjustPoints` 被 roundPoints 归 0 → 静默不发奖励。
 * 凡是「管理员手输 / 前端传数」的金额与配置，都必须先过这道。
 */
export function toFiniteNumber(v: unknown, fallback: number): number {
  // 显式排除 Number() 的几种「惊喜」：Number(null)=0、Number('')=0、Number([])=0。
  // 对金额/配置字段来说，「空」不等于 0，混进 0 会变成免费/无门槛。
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 同 toFiniteNumber，但把非有限值/负数统一夹到 0（用于配额、数量等「不允许负」的字段）。 */
export function toNonNegative(v: unknown): number {
  const n = toFiniteNumber(v, 0)
  return n > 0 ? n : 0
}

/** 积分保留小数位（2 位足够，与前端展示一致） */
export const POINTS_DECIMALS = 2

/** 把任意积分值规整到 2 位小数（消除浮点误差） */
export function roundPoints(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/** 模型促销计价：有效积分 = 免费 ? 0 : costPoints × 折扣率（保留 2 位小数） */
export function effectivePoints(costPoints: number, discount?: number | null, isFree?: boolean): number {
  if (isFree) return 0
  const base = Number(costPoints) || 0
  if (discount != null && discount > 0 && discount < 1) return roundPoints(base * discount)
  return roundPoints(base)
}

/** 带「折扣时间窗」的模型形状（ModelConfig / 序列化后的行都满足） */
export interface DiscountWindowSource {
  discount?: number | null
  discountStartsAt?: Date | string | null
  discountEndsAt?: Date | string | null
}

/**
 * 模型**当前实际生效**的折扣——计费（charge-run / canvas-executor / billing-plans / 价格目录）
 * 与展示（/api/models）读取折扣的唯一入口，禁止直接读 `model.discount`。
 *
 * 为什么存在：折扣率本来是永久字段；限时活动这类限时活动价加了时间窗后，
 * 「窗口外 = 无折扣」的判断如果散在各调用点，必然漏一处 → 用户按活动价永久扣费。
 * 集中在这里，窗口外返回 null（= 原价），到点自动恢复，无需人工改回。
 * 两个时间字段都为空 = 永久生效（向后兼容既有配置）。
 */
export function activeDiscount<T extends DiscountWindowSource>(model: T, now: Date = new Date()): number | null {
  const d = model.discount
  if (d == null || !(d > 0 && d < 1)) return null
  if (model.discountStartsAt && now < new Date(model.discountStartsAt)) return null
  if (model.discountEndsAt && now > new Date(model.discountEndsAt)) return null
  return d
}

/** 展示用：去掉无意义的小数尾巴（1.00 → 1，0.60 → 0.6） */
export function formatPoints(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0'
  const r = roundPoints(n)
  return String(r)
}

/**
 * 参考生图单价（积分/张，1K 档）。
 *
 * 为什么需要它：用量要对用户讲清楚「这些积分大概能生成多少张图」，
 * 但模型可随时调价，逐套餐去查库不现实。这里取「入门生图模型 1K 参考价」
 * 作为 UI 示例中的换算基准。
 * 它只用于**展示估算**，绝不参与真实扣费（真实扣费走 billing-plans 的按档位计价）。
 */
export const REFERENCE_IMAGE_POINTS = 3

/**
 * 把积分数换算成「大约可生成多少张图」（向下取整）。
 * 低于 1 张时返回 0，由调用方决定要不要展示。
 */
export function estimateImageCount(points: number | null | undefined): number {
  const p = roundPoints(Number(points) || 0)
  if (p <= 0) return 0
  return Math.floor(p / REFERENCE_IMAGE_POINTS)
}

/**
 * 视频参考豆价：会员套餐「免费视频 N 天」换算用的单一锚点。
 * 这里取外接主力模型的常见单次量级；运营调整主力活动模型后同步改这里。
 */
export const REFERENCE_VIDEO_BEANS = 10

/**
 * 把豆数换算成「大约可生成多少个视频」（向下取整）。
 * 低于 1 个时返回 0，由调用方决定要不要展示。与 estimateImageCount 同口径（展示估算，不参与扣费）。
 */
export function estimateVideoCount(beans: number | null | undefined): number {
  const b = Number(beans) || 0
  if (b <= 0) return 0
  return Math.floor(b / REFERENCE_VIDEO_BEANS)
}
