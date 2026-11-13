import { describe, it, expect } from 'vitest'
import { roundPoints, toFiniteNumber, toNonNegative } from '@/lib/pricing'

// 金额/配置字段来自 JSON，`Number('abc')` = NaN。
// NaN 的比较全为 false —— `NaN > 1000`、`NaN < 0`、`NaN >= 0` 都不成立，
// 会穿过所有「范围校验」。实测过的三类后果：
//   1) 审核奖励 NaN → adjustPoints 被归 0 → 静默不发奖励
//   2) costPoints NaN → roundPoints 归 0 → 模型被改成免费
//   3) contextWindow NaN → 落库后绕过 `> 0` 判断，历史预算算错
// 这里锁住「统一入口」的行为，避免再有人直接用 Number()/parseInt() 裸解析。

describe('toFiniteNumber —— 非法值回落兜底，绝不返回 NaN', () => {
  it('非数字 → fallback', () => {
    for (const v of ['abc', undefined, null, {}, [], NaN, Infinity, -Infinity]) {
      const r = toFiniteNumber(v, 7)
      expect(Number.isFinite(r), `toFiniteNumber(${String(v)})`).toBe(true)
      expect(r).toBe(7)
    }
  })
  it('合法数字原样返回', () => {
    expect(toFiniteNumber('42', 0)).toBe(42)
    expect(toFiniteNumber(3.5, 0)).toBe(3.5)
    expect(toFiniteNumber(0, 7)).toBe(0)
  })
})

describe('toNonNegative —— 配额类字段不允许负/NaN', () => {
  it('负数与 NaN → 0', () => {
    expect(toNonNegative(-5)).toBe(0)
    expect(toNonNegative('abc')).toBe(0)
    expect(toNonNegative(undefined)).toBe(0)
  })
  it('正数原样', () => {
    expect(toNonNegative('30')).toBe(30)
  })
})

describe('roundPoints —— 非法值归 0（因此调用方必须先校验）', () => {
  it('NaN/Infinity → 0', () => {
    expect(roundPoints(NaN)).toBe(0)
    expect(roundPoints(Infinity)).toBe(0)
  })
  it('正常保留 2 位', () => {
    expect(roundPoints(0.605)).toBe(0.61)
    expect(roundPoints(6)).toBe(6)
  })
})
