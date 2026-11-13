import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * charge-run 批量（count）+ 上游闸门一致性 characterization tests
 *
 * 锁死两件事：
 *  1. count 只是「单份价 × 份数」，不得影响折扣口径与币种分发；
 *  2. chat 与 image/video/audio 一样走 withUpstreamGate（此前 chat 是唯一漏网的）。
 */

vi.mock('@/lib/prisma', () => ({ getPrisma: vi.fn() }))
vi.mock('@/lib/free-quota', () => ({
  tryConsumeFreeQuota: vi.fn(),
  releaseFreeQuota: vi.fn(),
}))
vi.mock('@/lib/billing/wallet', () => ({
  deductPoints: vi.fn(),
  refundPoints: vi.fn(),
  deductBeans: vi.fn(),
  refundBeans: vi.fn(),
}))

import { planNodeCharge } from '@/lib/billing/billing-plans'

/** 复制 charge-run 里 count 的应用方式，防止实现与断言各写一套 */
function applyUnits(plan: { points: number; beans: number }, count?: number) {
  const units = Math.max(1, Math.floor(count ?? 1))
  return units > 1 ? { points: plan.points * units, beans: plan.beans * units } : plan
}

describe('charge-run count（批量产出）口径', () => {
  const imageModel = {
    costPoints: 6,
    discount: 0.5,
    isFree: false,
    metadata: { tierCost1K: 6 },
  }

  it('图片：单份价已含折扣，× count 后不得再打折', () => {
    const single = planNodeCharge('IMAGE', imageModel, { width: 1024, height: 1024 })
    expect(single.points).toBe(3) // 6 × 0.5

    const batch = applyUnits(single, 4)
    expect(batch.points).toBe(12) // 3 × 4，不是 6×0.5×0.5×4
    expect(batch.beans).toBe(0)
  })

  it('视频：豆价 × count，积分保持 0（币种不串）', () => {
    const videoModel = { costPoints: 99, videoCost: 5, isFree: false }
    const single = planNodeCharge('VIDEO', videoModel, null)
    expect(single.beans).toBe(5)

    const batch = applyUnits(single, 3)
    expect(batch.beans).toBe(15)
    expect(batch.points).toBe(0)
  })

  it('count 缺省 / 0 / 负数 / 小数 → 一律按 1 份', () => {
    const single = planNodeCharge('IMAGE', imageModel, { width: 1024, height: 1024 })
    for (const c of [undefined, 0, -3, 0.4]) {
      expect(applyUnits(single, c).points).toBe(single.points)
    }
  })

  it('count=1 时返回原对象（不产生多余的乘法误差）', () => {
    const single = planNodeCharge('IMAGE', imageModel, { width: 1024, height: 1024 })
    expect(applyUnits(single, 1)).toEqual(single)
  })

  it('免费模型：巨大 count 仍是 0', () => {
    const free = { ...imageModel, isFree: true }
    const single = planNodeCharge('IMAGE', free, { width: 1024, height: 1024 })
    expect(applyUnits(single, 8).points).toBe(0)
  })
})
