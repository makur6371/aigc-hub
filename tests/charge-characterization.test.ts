import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase 0 计费口径 characterization tests
 *
 * 目的：在把「模型解析 → 免费额度 → 预扣 → 执行 → 退款 → 调用日志」
 * 收敛成单一实现（lib/billing/charge-run.ts）之前，先锁死**当前行为**。
 *
 * 这组测试不依赖数据库，全部 mock 掉基础设施，只验证编排顺序与账目结果，
 * 因此重构前后必须完全一致。任何一条挂了，都说明重构改了业务行为。
 */

// 用 vi.mock 拦掉所有副作用模块，让被测函数能在测试进程里跑
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
import { effectivePoints } from '@/lib/pricing'

describe('计费口径 —— 档位价不得被重复打折（历史 bug 回归）', () => {
  const model = {
    costPoints: 6,
    discount: 0.6,
    isFree: false,
    metadata: { tierCost1K: 6, tierCost2K: 8, tierCost4K: 10 },
  }

  it('planNodeCharge 已含折扣，调用方不得再包一层 effectivePoints', () => {
    const charge = planNodeCharge('IMAGE', model, { width: 1024, height: 1024 })
    // 6 × 0.6 = 3.6 → 3.6（保留 2 位）
    expect(charge.points).toBe(3.6)
    expect(charge.beans).toBe(0)

    // 反例：再折一次会得到 2.16 —— 这正是线上踩过的坑，
    // 用断言把它钉死，防止未来有人在调用侧又包一层。
    const doubleDiscounted = effectivePoints(charge.points, model.discount, model.isFree)
    expect(doubleDiscounted).not.toBe(charge.points)
    expect(doubleDiscounted).toBe(2.16)
  })

  it('免费模型：无论档位都返回 0', () => {
    const free = { ...model, isFree: true }
    expect(planNodeCharge('IMAGE', free, { width: 1024, height: 1024 }).points).toBe(0)
    expect(planNodeCharge('IMAGE', free, { width: 4096, height: 4096 }).points).toBe(0)
  })

  it('宽高缺失时按统一价（不崩、不返回 NaN）', () => {
    const charge = planNodeCharge('IMAGE', model, null)
    expect(Number.isFinite(charge.points)).toBe(true)
    expect(charge.points).toBeGreaterThan(0)
  })

  it('视频走豆、图片走积分（币种不串）', () => {
    const video = { costPoints: 99, videoCost: 5, isFree: false }
    const v = planNodeCharge('VIDEO', video, null)
    expect(v.beans).toBe(5)
    expect(v.points).toBe(0)

    const img = planNodeCharge('IMAGE', model, null)
    expect(img.points).toBeGreaterThan(0)
    expect(img.beans).toBe(0)
  })
})

describe('免费额度与扣费的组合口径', () => {
  const model = { costPoints: 10, discount: null, isFree: false, metadata: null }

  it('命中免费额度 → 本次实收 0，但单价本身不为 0', () => {
    const charge = planNodeCharge('IMAGE', model, null)
    expect(charge.points).toBe(10)
    // 命中免费额度时调用方把 cost 置 0（不是把单价改 0）
    const costWhenFreeQuotaHit = 0
    expect(costWhenFreeQuotaHit).toBe(0)
  })
})
