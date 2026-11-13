import crypto from 'crypto'
import { roundPoints } from '@/lib/pricing'

export const CARD_KEY_TYPES = ['POINTS_PACKAGE', 'SUBSCRIPTION', 'BEANS_PACKAGE'] as const
export type CardKeyType = (typeof CARD_KEY_TYPES)[number]

export type CardKeyBatchInput = {
  type: CardKeyType
  pointsValue: number | null
  beansValue: number | null
  durationDays: number | null
  freeImageDays: number | null
  count: number
  expiresAt: Date | null
}

export type CardKeyBatchParseResult =
  | { ok: false; error: string }
  | { ok: true; data: CardKeyBatchInput }

export function generateCardKeyCode(): string {
  return `AIGC_HUB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`
}

export function parseCardKeyBatchInput(body: {
  type?: unknown
  pointsValue?: unknown
  beansValue?: unknown
  durationDays?: unknown
  freeImageDays?: unknown
  count?: unknown
  expiresAt?: unknown
}): CardKeyBatchParseResult {
  if (typeof body.type !== 'string' || !CARD_KEY_TYPES.includes(body.type as CardKeyType)) {
    return { ok: false, error: '请选择有效的卡密类型' }
  }
  const type = body.type as CardKeyType

  const parsedCount = Number(body.count)
  const count = Number.isFinite(parsedCount) && parsedCount > 0
    ? Math.min(1000, Math.max(1, Math.round(parsedCount)))
    : 1

  const rawPoints = body.pointsValue == null || body.pointsValue === '' ? 0 : Number(body.pointsValue)
  const rawBeans = body.beansValue == null || body.beansValue === '' ? 0 : Number(body.beansValue)
  if (!Number.isFinite(rawPoints) || rawPoints < 0) {
    return { ok: false, error: '积分值必须是非负数' }
  }
  if (!Number.isFinite(rawBeans) || rawBeans < 0) {
    return { ok: false, error: '豆值必须是非负数' }
  }
  const points = roundPoints(rawPoints)
  const beans = roundPoints(rawBeans)

  let durationDays: number | null = null
  if (type === 'SUBSCRIPTION') {
    const rawDuration = body.durationDays == null || body.durationDays === '' ? 30 : Number(body.durationDays)
    durationDays = Number.isFinite(rawDuration) ? Math.round(rawDuration) : NaN
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
      return { ok: false, error: '订阅天数需为 1~3650 的整数' }
    }
  }

  if (type === 'POINTS_PACKAGE' && points <= 0) {
    return { ok: false, error: '积分卡密面值必须大于 0' }
  }
  if (type === 'BEANS_PACKAGE' && beans <= 0) {
    return { ok: false, error: '豆卡密面值必须大于 0' }
  }

  const freeImageDays = type === 'SUBSCRIPTION' && body.freeImageDays != null && body.freeImageDays !== '' ? Number(body.freeImageDays) : null
  if (freeImageDays != null && (!Number.isInteger(freeImageDays) || freeImageDays < 0 || freeImageDays > 3650)) {
    return { ok: false, error: '赠送生图时长需为 0~3650 的整数天' }
  }

  let expiresAt: Date | null = null
  if (body.expiresAt != null && body.expiresAt !== '') {
    if (typeof body.expiresAt !== 'string') {
      return { ok: false, error: '过期时间格式无效' }
    }
    expiresAt = new Date(body.expiresAt)
    if (!Number.isFinite(expiresAt.getTime())) {
      return { ok: false, error: '过期时间格式无效' }
    }
    if (expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: '过期时间必须晚于当前时间' }
    }
  }

  return {
    ok: true,
    data: {
      type,
      pointsValue: type === 'POINTS_PACKAGE' || type === 'SUBSCRIPTION' ? points : null,
      beansValue: type === 'BEANS_PACKAGE' || type === 'SUBSCRIPTION' ? beans : null,
      durationDays,
      freeImageDays,
      count,
      expiresAt,
    },
  }
}
