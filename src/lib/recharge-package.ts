/**
 * 充值套餐字段校验与归一化（管理员创建/更新共用）。
 * 返回判别联合：error 为 null 时 data 可用，TS 可安全收窄。
 */
import type { Prisma } from '@prisma/client'
import { roundPoints } from '@/lib/pricing'

export type RechargePackageInput = Prisma.RechargePackageUncheckedCreateInput & {
  name: string
  priceCents: number
}

export type ParseResult =
  | { ok: false; error: string }
  | { ok: true; data: RechargePackageInput }

export function parsePackageInput(body: {
  name?: unknown
  priceCents?: unknown
  points?: unknown
  beans?: unknown
  isSubscription?: unknown
  kind?: unknown
  durationDays?: unknown
  freeImageDays?: unknown
  sortOrder?: unknown
  isActive?: unknown
}): ParseResult {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const priceCents = typeof body.priceCents === 'number' ? Math.round(body.priceCents) : NaN
  const rawPoints = typeof body.points === 'number' ? body.points : 0
  const rawBeans = typeof body.beans === 'number' ? body.beans : 0
  const points = Number.isFinite(rawPoints) ? roundPoints(rawPoints) : NaN
  const beans = Number.isFinite(rawBeans) ? roundPoints(rawBeans) : NaN
  const isSubscription = body.isSubscription === true
  // kind 由内容自动推导（前端分组展示）：订阅 → subscription；只给豆 → beans；其余 → points
  const kind = isSubscription ? 'subscription' : (beans > 0 && points === 0 ? 'beans' : 'points')
  const durationDays =
    isSubscription && typeof body.durationDays === 'number' && Number.isFinite(body.durationDays)
      ? Math.round(body.durationDays)
      : null
  // 订阅套餐附带的免费无限生图天数（3/5/10）；非订阅强制 null
  const rawFreeImageDays =
    isSubscription && typeof body.freeImageDays === 'number' && Number.isFinite(body.freeImageDays)
      ? Math.round(body.freeImageDays)
      : null
  const sortOrder = typeof body.sortOrder === 'number' ? Math.round(body.sortOrder) : 0
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : true

  const error =
    !name
      ? '请输入套餐名称'
      : !Number.isFinite(priceCents) || priceCents < 100
        ? '价格不能低于 1 元'
        : !Number.isFinite(points) || !Number.isFinite(beans) || points < 0 || beans < 0
          ? '积分数/豆数不能为负数'
          : isSubscription && (!durationDays || durationDays < 1 || durationDays > 3650)
            ? '订阅套餐需填写 1~3650 天的有效期'
            : rawFreeImageDays != null && (rawFreeImageDays < 0 || rawFreeImageDays > 3650)
              ? '免费无限生图天数需为 0~3650'
            : points === 0 && beans === 0
              ? '积分数和豆数至少填写一个'
              : null

  if (error) return { ok: false, error }
  return {
    ok: true,
    data: { name, priceCents, points, beans, isSubscription, kind, durationDays, freeImageDays: rawFreeImageDays, sortOrder, isActive },
  }
}
