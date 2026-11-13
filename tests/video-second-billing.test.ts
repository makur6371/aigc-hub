import { describe, it, expect } from 'vitest'
import { resolvePerSecondBeans, resolvePerSecondPoints, resolveVideoBeans, validateVideoParams } from '@/lib/billing/billing-plans'

// 按秒计费对「非有限秒数」必须安全。
// 真实漏洞：JSON 里 `1e999` 是合法数字，解析成 Infinity；`Math.ceil(Infinity)=Infinity`，
// 而 `roundPoints(Infinity)=0` → **算出 0 豆**，用户白嫖一次视频。
// NaN 同理（且 NaN 的比较全 false，会绕过时长约束校验）。
// 修法：秒数只认有限正数，其余按最短 1 秒计（保守，宁可少扣也不放走 0）。

const legacy = { costPoints: 0, videoCost: 0, metadata: { perSecondBeans: 10 }, isFree: false }
const factor = { costPoints: 0, videoCost: 0, metadata: { video: { billing: { perCall: 50, perOutputSecond: 10 } } }, isFree: false }
const audio = { costPoints: 0, videoCost: 0, metadata: { perSecondCost: 2 }, isFree: false }
const perSecondOnly = { costPoints: 0, videoCost: 0, metadata: { video: { billing: { perOutputSecond: 10 } } }, isFree: false }

describe('按秒计价 —— Infinity/NaN 不能算出 0', () => {
  it('正常秒数照常计价（不改变现有行为）', () => {
    expect(resolvePerSecondBeans(legacy, 5)).toBe(50)
    expect(resolveVideoBeans(factor, { durationSec: 5 })).toBe(100)
    expect(resolvePerSecondPoints(audio, 5)).toBe(10)
  })

  it('Infinity 不再归 0（旧 bug）', () => {
    expect(resolvePerSecondBeans(legacy, Infinity)).toBeGreaterThan(0)
    expect(resolveVideoBeans(factor, { durationSec: Infinity })).toBeGreaterThan(0)
    expect(resolvePerSecondPoints(audio, Infinity)).toBeGreaterThan(0)
  })

  it('NaN 不再归 0', () => {
    expect(resolvePerSecondBeans(legacy, NaN)).toBeGreaterThan(0)
    expect(resolveVideoBeans(factor, { durationSec: NaN })).toBeGreaterThan(0)
  })

  it('只有 perOutputSecond 的因子制模型也不能被 Infinity/NaN 免费', () => {
    expect(resolveVideoBeans(perSecondOnly, { durationSec: 5 })).toBe(50)
    expect(resolveVideoBeans(perSecondOnly, { durationSec: Infinity })).toBeGreaterThan(0)
    expect(resolveVideoBeans(perSecondOnly, { durationSec: NaN })).toBeGreaterThan(0)
  })
})

describe('validateVideoParams —— 非有限时长必须拦下', () => {
  it('NaN/Infinity/0/负数 → 报错', () => {
    for (const d of [NaN, Infinity, -Infinity, 0, -5]) {
      expect(validateVideoParams({ costPoints: 0, metadata: null }, { duration: d }), `duration=${d}`).toBeTruthy()
    }
  })
  it('有限正数 → 通过（无约束时）', () => {
    expect(validateVideoParams({ costPoints: 0, metadata: null }, { duration: 5 })).toBeNull()
  })
})
