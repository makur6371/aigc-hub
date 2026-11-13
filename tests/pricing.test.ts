import { describe, it, expect } from 'vitest'
import {
  roundPoints,
  effectivePoints,
  formatPoints,
  POINTS_DECIMALS,
  estimateImageCount,
  REFERENCE_IMAGE_POINTS,
} from '@/lib/pricing'

// 为什么先测这个：积分是钱。算错一位小数就是真实的账目差错。
// 历史真实事故：6 积分 × 0.1 折 = 0.6，浮点算出 0.6000000000000001。
describe('roundPoints —— 小数积分规整', () => {
  it('规整到 2 位小数，消除浮点残差', () => {
    expect(roundPoints(0.6000000000000001)).toBe(0.6)
    expect(roundPoints(0.1 + 0.2)).toBe(0.3)
    expect(roundPoints(2.345)).toBe(2.35)
  })

  // 已知边界（不是 bug，是 Math.round 的固有特性，记录以防后人误改）：
  //   1.005 的二进制实际值是 1.00499999999999989…，所以 ×100 得 100.4999…，
  //   半值会「向下」舍入成 1 而不是 1.01。
  // 业务上折扣算出的金额几乎不会精确落在 x.xx5，所以现有实现足够；
  // 真要改需全量回归既有账目，收益远小于风险 —— 保持现状并用测试锁定行为。
  it('记录半值舍入的既有行为（Math.round 特性）', () => {
    // 两者二进制都偏下，所以都向下舍入 —— 用测试把当前行为钉住，
    // 将来有人想改 roundPoints 时必须先解释为什么这些期望要变。
    expect(roundPoints(1.005)).toBe(1)
    expect(roundPoints(1.015)).toBe(1.01)
  })

  it('整数原样返回', () => {
    expect(roundPoints(6)).toBe(6)
    expect(roundPoints(0)).toBe(0)
  })

  it('负数保持符号（退款用负数金额）', () => {
    expect(roundPoints(-0.6000000000000001)).toBe(-0.6)
  })

  it('非有限值兜底为 0（NaN/Infinity 不该污染账目）', () => {
    expect(roundPoints(NaN)).toBe(0)
    expect(roundPoints(Infinity)).toBe(0)
    expect(roundPoints(-Infinity)).toBe(0)
  })

  it('小数位数常量是 2', () => {
    expect(POINTS_DECIMALS).toBe(2)
  })
})

describe('effectivePoints —— 促销计价', () => {
  it('免费模型恒为 0（忽略折扣）', () => {
    expect(effectivePoints(100, 0.5, true)).toBe(0)
    expect(effectivePoints(100, null, true)).toBe(0)
  })

  it('折扣：0.1 折 = 原价 × 0.1', () => {
    expect(effectivePoints(6, 0.1)).toBe(0.6)
    expect(effectivePoints(100, 0.5)).toBe(50)
  })

  it('折扣边界：0 与 1 都不打折（0 会被当作未配置）', () => {
    expect(effectivePoints(100, 0)).toBe(100)
    expect(effectivePoints(100, 1)).toBe(100)
    expect(effectivePoints(100, null)).toBe(100)
    expect(effectivePoints(100, undefined)).toBe(100)
  })

  it('非法的 costPoints 兜底为 0', () => {
    expect(effectivePoints(NaN)).toBe(0)
    expect(effectivePoints(undefined as unknown as number)).toBe(0)
  })

  it('结果同样规整到 2 位（不产生长尾小数）', () => {
    // 33 × 0.33 = 10.89，浮点安全；换成会产生残差的组合验证规整生效
    expect(effectivePoints(3, 0.1)).toBe(0.3)
    expect(String(effectivePoints(7, 0.1)).length).toBeLessThanOrEqual(3)
  })
})

describe('formatPoints —— 展示格式', () => {
  it('去掉无意义的小数尾巴', () => {
    expect(formatPoints(1.0)).toBe('1')
    expect(formatPoints(0.6)).toBe('0.6')
    expect(formatPoints(10.89)).toBe('10.89')
  })

  it('null/undefined/NaN 显示 0（不要显示 NaN 吓用户）', () => {
    expect(formatPoints(null)).toBe('0')
    expect(formatPoints(undefined)).toBe('0')
    expect(formatPoints(NaN)).toBe('0')
  })
})

// 「约可生成 N 张图」是给用户看的**估算**，绝不能参与真实扣费。
// 锁定基准值：模型调价时这里会先失败，逼开发者明确「换算基准变了」。
describe('estimateImageCount —— 积分数换算参考张数', () => {
  it('基准单价锁定为 3 积分/张（1K 参考价）', () => {
    expect(REFERENCE_IMAGE_POINTS).toBe(3)
  })

  it('向下取整（不足一张算 0）', () => {
    expect(estimateImageCount(0)).toBe(0)
    expect(estimateImageCount(2.9)).toBe(0)
    expect(estimateImageCount(3)).toBe(1)
    expect(estimateImageCount(5)).toBe(1)
    expect(estimateImageCount(6)).toBe(2)
    expect(estimateImageCount(1200)).toBe(400)
  })

  it('非数/负数回 0，不抛错', () => {
    expect(estimateImageCount(null)).toBe(0)
    expect(estimateImageCount(undefined)).toBe(0)
    expect(estimateImageCount(NaN)).toBe(0)
    expect(estimateImageCount(-10)).toBe(0)
  })
})
