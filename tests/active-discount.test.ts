import { describe, it, expect } from 'vitest'
import { activeDiscount, estimateVideoCount, REFERENCE_VIDEO_BEANS } from '@/lib/pricing'

// 限时活动价（限时活动）的时间窗口径（2026-11-02）
//
// 背景：折扣率 ModelConfig.discount 本是永久字段；参考 LibTV 的活动价打法加了时间窗后，
// 「窗口外 = 原价」是钱的事——漏一处判断用户就按活动价永久扣费。
// activeDiscount 是计费与展示读取折扣的唯一入口，这里钉死窗口语义。
describe('activeDiscount 时间窗', () => {
  const model = {
    discount: 0.6,
    discountStartsAt: new Date('2026-11-08T00:00:00+08:00'),
    discountEndsAt: new Date('2026-11-12T23:59:59+08:00'),
  }

  it('窗口内生效', () => {
    expect(activeDiscount(model, new Date('2026-11-11T12:00:00+08:00'))).toBe(0.6)
  })

  it('开始前不生效（到点自动开，无需人工切换）', () => {
    expect(activeDiscount(model, new Date('2026-11-07T23:59:59+08:00'))).toBeNull()
  })

  it('结束后不生效（到点自动恢复原价——忘记改回也不亏损）', () => {
    expect(activeDiscount(model, new Date('2026-11-13T00:00:00+08:00'))).toBeNull()
  })

  it('只有单边窗口也成立：只配结束时间 = 立即生效到点截止', () => {
    expect(activeDiscount({ discount: 0.5, discountEndsAt: new Date('2026-11-12T00:00:00+08:00') }, new Date('2026-11-10T00:00:00+08:00'))).toBe(0.5)
    expect(activeDiscount({ discount: 0.5, discountEndsAt: new Date('2026-11-12T00:00:00+08:00') }, new Date('2026-11-13T00:00:00+08:00'))).toBeNull()
  })

  it('未配置时间窗 = 永久生效（向后兼容既有配置，行为与旧字段完全一致）', () => {
    expect(activeDiscount({ discount: 0.8 })).toBe(0.8)
  })

  it('无折扣 / 折扣率 1 / null 一律返回 null（不进 effectivePoints 的折扣分支）', () => {
    expect(activeDiscount({ discount: null })).toBeNull()
    expect(activeDiscount({ discount: 1 })).toBeNull()
  })

  it('时间字段接受 ISO 字符串（JSON 序列化路径）', () => {
    expect(activeDiscount({ discount: 0.6, discountEndsAt: '2026-11-12T23:59:59+08:00' }, new Date('2026-11-10T00:00:00+08:00'))).toBe(0.6)
  })
})

describe('会员豆量换算（限时活动免费视频活动）', () => {
  it('estimateVideoCount 按参考豆价向下取整', () => {
    expect(estimateVideoCount(3000)).toBe(300)
    expect(estimateVideoCount(15)).toBe(1)
    expect(estimateVideoCount(9)).toBe(0)
    expect(estimateVideoCount(0)).toBe(0)
    expect(estimateVideoCount(null)).toBe(0)
  })

  it('参考豆价为正数（为 0 会让换算除零/失真）', () => {
    expect(REFERENCE_VIDEO_BEANS).toBeGreaterThan(0)
  })
})
