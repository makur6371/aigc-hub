import { describe, it, expect } from 'vitest'
import {
  resolveFreeQuotaMaxTier,
  isTierFreeQuotaEligible,
  FREE_QUOTA_MAX_TIER_KEY,
} from '@/lib/free-quota'

// 免费额度按「次数」计，但生图成本随档位翻倍（tierCost1K/2K/4K）。
// 原实现只有「每用户 N 次 / 平台 M 次」，不约束用户用哪一档 →
// 用户能把 10 次免费额度全花在 4K 上：平台按 1K 的价位备额度，实际付 4K 的成本。
// 这就是 freeQuotaMaxTier 要解决的。

describe('resolveFreeQuotaMaxTier —— 配置读取', () => {
  it('不配 = 不限制（老模型不用改配置，行为不变）', () => {
    expect(resolveFreeQuotaMaxTier(null)).toBeNull()
    expect(resolveFreeQuotaMaxTier(undefined)).toBeNull()
    expect(resolveFreeQuotaMaxTier({})).toBeNull()
    expect(resolveFreeQuotaMaxTier({ tierCost1K: 5 })).toBeNull()
  })

  it('空串视为未配（后台 allowClear 清空后不应变成「限制到 1K」）', () => {
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: '' })).toBeNull()
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: '   ' })).toBeNull()
  })

  it('大小写归一（手改 DB 可能是小写 2k）', () => {
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: '2k' })).toBe('2K')
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: '4K' })).toBe('4K')
  })

  it('非字符串一律当未配（脏数据不能把上限变成真值）', () => {
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: 2 })).toBeNull()
    expect(resolveFreeQuotaMaxTier({ [FREE_QUOTA_MAX_TIER_KEY]: true })).toBeNull()
  })

  it('Prisma metadata 是 JsonValue：数组/标量不崩也不当配置', () => {
    expect(resolveFreeQuotaMaxTier([1, 2, 3])).toBeNull()
    expect(resolveFreeQuotaMaxTier('1K')).toBeNull()
    expect(resolveFreeQuotaMaxTier(42)).toBeNull()
  })
})

describe('isTierFreeQuotaEligible —— 档位判定', () => {
  it('未配置上限 → 全部放行（既有行为不变）', () => {
    for (const t of ['1K', '2K', '4K', undefined, null, 'WEIRD']) {
      expect(isTierFreeQuotaEligible(t, null)).toBe(true)
    }
  })

  it('上限 1K：只有 1K 免费，2K/4K 走正常计费', () => {
    expect(isTierFreeQuotaEligible('1K', '1K')).toBe(true)
    expect(isTierFreeQuotaEligible('2K', '1K')).toBe(false)
    expect(isTierFreeQuotaEligible('4K', '1K')).toBe(false)
  })

  it('上限 2K：1K/2K 免费，4K 付费', () => {
    expect(isTierFreeQuotaEligible('1K', '2K')).toBe(true)
    expect(isTierFreeQuotaEligible('2K', '2K')).toBe(true)
    expect(isTierFreeQuotaEligible('4K', '2K')).toBe(false)
  })

  it('上限 4K = 不限制（全放行）', () => {
    for (const t of ['1K', '2K', '4K']) {
      expect(isTierFreeQuotaEligible(t, '4K')).toBe(true)
    }
  })

  it('档位解不出来时按最低档处理（不因算不出档位就放行 4K）', () => {
    expect(isTierFreeQuotaEligible(undefined, '1K')).toBe(true)
    expect(isTierFreeQuotaEligible(null, '1K')).toBe(true)
    expect(isTierFreeQuotaEligible(undefined, '2K')).toBe(true)
    expect(isTierFreeQuotaEligible(undefined, '4K')).toBe(true)
  })

  it('未知档位名按最低档处理（脏数据不放行更高档）', () => {
    expect(isTierFreeQuotaEligible('8K', '1K')).toBe(true)
    expect(isTierFreeQuotaEligible('8K', '2K')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isTierFreeQuotaEligible('4k', '2K')).toBe(false)
    expect(isTierFreeQuotaEligible('2k', '2K')).toBe(true)
  })
})
