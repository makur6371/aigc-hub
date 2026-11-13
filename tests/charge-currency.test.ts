import { describe, it, expect } from 'vitest'
import { resolvePerSecondPoints, resolvePerSecondBeans, planNodeCharge } from '@/lib/billing/billing-plans'

/**
 * charge-run 的币种分发依赖这三个函数的语义，这里把口径钉死。
 * 视频走豆、音频可按时长走积分、图片按档位走积分 —— 串了就是资损。
 */

describe('resolvePerSecondPoints —— 音频按秒（积分）', () => {
  it('配了 perSecondCost 且有时长 → 单价 × 秒数（含折扣）', () => {
    const m = { costPoints: 99, metadata: { perSecondCost: 2 } }
    expect(resolvePerSecondPoints(m, 10)).toBe(20)
  })

  it('配了折扣时按折后价', () => {
    const m = { costPoints: 99, discount: 0.5, metadata: { perSecondCost: 2 } }
    expect(resolvePerSecondPoints(m, 10)).toBe(10)
  })

  it('未配 perSecondCost → null（回退按次计价）', () => {
    expect(resolvePerSecondPoints({ costPoints: 5, metadata: {} }, 10)).toBeNull()
  })

  it('免费模型 → 0', () => {
    expect(resolvePerSecondPoints({ costPoints: 5, isFree: true, metadata: { perSecondCost: 2 } }, 10)).toBe(0)
  })

  it('缺时长时按 1 秒兜底（不返回 null、不返回 NaN）', () => {
    const r = resolvePerSecondPoints({ costPoints: 5, metadata: { perSecondCost: 3 } }, undefined)
    expect(r).toBe(3)
  })
})

describe('resolvePerSecondBeans —— 视频按秒（豆）', () => {
  it('配了 perSecondBeans 且有时长 → 豆价 × 秒数', () => {
    const m = { costPoints: 0, metadata: { perSecondBeans: 0.5 } }
    expect(resolvePerSecondBeans(m, 8)).toBe(4)
  })

  it('未配 → null（回退 videoCost 一口价）', () => {
    expect(resolvePerSecondBeans({ costPoints: 0, metadata: {} }, 8)).toBeNull()
  })

  it('按秒豆价不受积分折扣影响（豆与积分是两套币种）', () => {
    const m = { costPoints: 99, discount: 0.1, metadata: { perSecondBeans: 2 } }
    // 折扣只作用于积分；豆价按原值 × 秒数
    expect(resolvePerSecondBeans(m, 5)).toBe(10)
  })
})

describe('币种不串：同一模型不可能同时扣积分与豆', () => {
  it('VIDEO 走豆、AUDIO 走积分', () => {
    const video = planNodeCharge('VIDEO', { costPoints: 0, videoCost: 5, isFree: false }, null)
    expect(video.beans).toBe(5)
    expect(video.points).toBe(0)

    const audio = planNodeCharge('AUDIO', { costPoints: 3, isFree: false }, null)
    expect(audio.points).toBe(3)
    expect(audio.beans).toBe(0)
  })

  it('免费视频 → 豆为 0', () => {
    const r = planNodeCharge('VIDEO', { costPoints: 0, videoCost: 5, isFree: true }, null)
    expect(r.beans).toBe(0)
  })
})
