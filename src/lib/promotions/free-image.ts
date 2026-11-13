export const FREE_IMAGE_DAY_MINUTES = 24 * 60

const ENV_MODEL_IDS = (process.env.FREE_IMAGE_PROMO_MODEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export interface PromoModelLike {
  id?: string
  type?: string
  dailyUserFreeQuota?: number | null
}

export interface PromoUserLike {
  freeImageUntil?: Date | null
}

export function isCampaignFreeImageModel(model: PromoModelLike): boolean {
  if (model.type !== 'IMAGE') return false
  if (ENV_MODEL_IDS.length > 0) return !!model.id && ENV_MODEL_IDS.includes(model.id)
  return (model.dailyUserFreeQuota ?? 0) > 0
}

/** 指定免费模型的时长权益，与订阅到期时间独立。 */
export function hasBonusFreeImage(user: PromoUserLike, now: Date = new Date()): boolean {
  return user.freeImageUntil != null && user.freeImageUntil.getTime() > now.getTime()
}

export function isPromoFreeImage(
  model: PromoModelLike,
  user: PromoUserLike,
  now: Date = new Date(),
): boolean {
  return isCampaignFreeImageModel(model) && hasBonusFreeImage(user, now)
}

/** 从「现在」或「已有截止时间」较晚者起算 +N 天（套餐赠送可叠加） */
export function nextFreeImageUntil(
  current: Date | null | undefined,
  days: number,
  now: Date = new Date(),
): Date {
  const minutes = Math.round(days * FREE_IMAGE_DAY_MINUTES)
  if (!Number.isSafeInteger(minutes) || Math.abs(minutes - days * FREE_IMAGE_DAY_MINUTES) > 0.000001 || minutes <= 0 || days > 3650) {
    throw new Error('生图时长需为正整数分钟，且不超过 3650 天')
  }
  const base = current && current.getTime() > now.getTime() ? current : now
  return new Date(base.getTime() + minutes * 60 * 1000)
}
