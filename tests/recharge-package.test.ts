import { describe, expect, it } from 'vitest'
import { parsePackageInput } from '@/lib/recharge-package'

describe('parsePackageInput', () => {
  it('接受有效积分包', () => {
    const result = parsePackageInput({ name: '积分包', priceCents: 990, points: 100, beans: 0 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.kind).toBe('points')
      expect(result.data.priceCents).toBe(990)
    }
  })

  it('拒绝 NaN / Infinity 积分和豆值', () => {
    expect(parsePackageInput({ name: '坏套餐', priceCents: 990, points: NaN }).ok).toBe(false)
    expect(parsePackageInput({ name: '坏套餐', priceCents: 990, beans: Infinity }).ok).toBe(false)
  })

  it('拒绝低价、负数、空权益', () => {
    expect(parsePackageInput({ name: '低价', priceCents: 99, points: 10 }).ok).toBe(false)
    expect(parsePackageInput({ name: '负数', priceCents: 990, points: -1 }).ok).toBe(false)
    expect(parsePackageInput({ name: '空包', priceCents: 990 }).ok).toBe(false)
  })

  it('订阅必须有合法时长', () => {
    expect(parsePackageInput({
      name: '订阅',
      priceCents: 990,
      points: 10,
      isSubscription: true,
      durationDays: 0,
    }).ok).toBe(false)
    expect(parsePackageInput({
      name: '订阅',
      priceCents: 990,
      points: 10,
      isSubscription: true,
      durationDays: 30,
    }).ok).toBe(true)
  })

  it('订阅可配置免费无限生图天数；非订阅强制 null', () => {
    const sub = parsePackageInput({
      name: '月度专业版',
      priceCents: 40000,
      points: 36000,
      isSubscription: true,
      durationDays: 30,
      freeImageDays: 5,
    })
    expect(sub.ok).toBe(true)
    if (sub.ok) expect(sub.data.freeImageDays).toBe(5)

    const plain = parsePackageInput({
      name: '积分包', priceCents: 20000, points: 2300, freeImageDays: 5,
    })
    expect(plain.ok).toBe(true)
    if (plain.ok) expect(plain.data.freeImageDays).toBeNull()

    expect(parsePackageInput({
      name: '月度', priceCents: 3000, points: 2700, isSubscription: true, durationDays: 30, freeImageDays: -1,
    }).ok).toBe(false)
  })
})
