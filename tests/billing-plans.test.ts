import { describe, it, expect } from 'vitest'
import {
  resolveTierCost,
  resolveImageCharge,
  resolvePerSecondPoints,
  resolvePerSecondBeans,
  planNodeCharge,
} from '@/lib/billing/billing-plans'

// 为什么测这个：档位定价是「同一模型 1K/2K/4K 收不同价」的唯一实现。
// 算错 = 要么赔钱（少收）要么用户投诉（多收）。
// 三条入口（画布/工具箱/直连 API）都调它，所以它是账目一致性的锚点。

describe('resolveTierCost —— 档位单价解析优先级', () => {
  it('该档位有专属价 → 用它', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: 10, tierCost2K: 20, tierCost4K: 40 } }
    expect(resolveTierCost(m, '1K')).toBe(10)
    expect(resolveTierCost(m, '2K')).toBe(20)
    expect(resolveTierCost(m, '4K')).toBe(40)
  })

  it('该档位没定价 → 沿用 1K 作为参考价', () => {
    const m = { costPoints: 99, metadata: { tierCost1K: 10 } }
    expect(resolveTierCost(m, '2K')).toBe(10)
    expect(resolveTierCost(m, '4K')).toBe(10)
  })

  it('完全没有档位定价 → 回落到 costPoints', () => {
    const m = { costPoints: 15, metadata: {} }
    expect(resolveTierCost(m, '2K')).toBe(15)
    expect(resolveTierCost(m, null)).toBe(15)
  })

  it('无 metadata → 回落到 costPoints（不崩）', () => {
    expect(resolveTierCost({ costPoints: 8 }, '1K')).toBe(8)
    expect(resolveTierCost({ costPoints: 8, metadata: null }, '1K')).toBe(8)
  })

  it('档位价为 0 是合法值（免费档位），不该被当成「未配置」', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: 0 } }
    expect(resolveTierCost(m, '1K')).toBe(0)
  })

  it('非数字的档位价被忽略', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: 'free' as unknown as number } }
    expect(resolveTierCost(m, '1K')).toBe(10)
  })

  it('负数档位价被忽略（防配置错误导致倒贴）', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: -5 } }
    expect(resolveTierCost(m, '1K')).toBe(10)
  })
})

describe('resolveImageCharge —— 生图按档位计价', () => {
  it('从宽高反解档位后取价', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: 10, tierCost2K: 20 } }
    expect(resolveImageCharge(m, 1024, 1024)).toBe(10) // 1K
    expect(resolveImageCharge(m, 2048, 2048)).toBe(20) // 2K
  })

  it('折扣生效', () => {
    const m = { costPoints: 10, discount: 0.5, metadata: { tierCost1K: 10 } }
    expect(resolveImageCharge(m, 1024, 1024)).toBe(5)
  })

  it('免费模型恒为 0', () => {
    const m = { costPoints: 10, isFree: true, metadata: { tierCost1K: 10 } }
    expect(resolveImageCharge(m, 1024, 1024)).toBe(0)
  })

  // ⚠️ 实测行为与 planNodeCharge 注释不符：注释说「宽高缺省时按统一价」，实际走 1K 参考价。
  // 已记入台账 Q-410。此处按**真实行为**锁定，防止后人照注释改坏。
  it('缺宽高 → 走 1K 参考价（与注释描述不同，以实测为准）', () => {
    const m = { costPoints: 12, metadata: { tierCost1K: 10, tierCost2K: 20 } }
    expect(resolveImageCharge(m, undefined, undefined)).toBe(10)
    expect(resolveImageCharge(m, 0, 0)).toBe(10)
  })

  it('缺宽高且未配 1K → 才回落到 costPoints', () => {
    const m = { costPoints: 12, metadata: {} }
    expect(resolveImageCharge(m, undefined, undefined)).toBe(12)
  })
})

describe('resolvePerSecondPoints / Beans —— 按秒计价', () => {
  it('未配置按秒价 → 返回 null（调用方回退按次）', () => {
    expect(resolvePerSecondPoints({ costPoints: 10 }, 5)).toBeNull()
    expect(resolvePerSecondBeans({ costPoints: 10 }, 5)).toBeNull()
  })

  it('按秒价 × 时长', () => {
    expect(resolvePerSecondPoints({ costPoints: 0, metadata: { perSecondCost: 2 } }, 5)).toBe(10)
    expect(resolvePerSecondBeans({ costPoints: 0, metadata: { perSecondBeans: 1.5 } }, 4)).toBe(6)
  })

  it('时长向上取整，且至少 1 秒（0 秒不该免费）', () => {
    expect(resolvePerSecondPoints({ costPoints: 0, metadata: { perSecondCost: 3 } }, 0)).toBe(3)
    expect(resolvePerSecondPoints({ costPoints: 0, metadata: { perSecondCost: 3 } }, 1.2)).toBe(6)
  })

  it('按秒价同样吃折扣', () => {
    const m = { costPoints: 0, discount: 0.5, metadata: { perSecondCost: 4 } }
    expect(resolvePerSecondPoints(m, 2)).toBe(4)
  })
})

describe('planNodeCharge —— 类型分发（预算/执行/前端三方共用）', () => {
  it('VIDEO → 只收豆，不收积分', () => {
    const m = { costPoints: 100, videoCost: 5 }
    expect(planNodeCharge('VIDEO', m)).toEqual({ points: 0, beans: 5 })
  })

  it('VIDEO 配了按秒价 → 预扣预算也按秒算（预算/实扣同口径）', () => {
    const m = { costPoints: 0, videoCost: null, metadata: { perSecondBeans: 1.5 } }
    // 8 秒 → 12 豆；若这里算成 0，会放行未预扣的任务（历史账目缺口）
    expect(planNodeCharge('VIDEO', m, { durationSec: 8 })).toEqual({ points: 0, beans: 12 })
  })

  it('VIDEO 按秒价优先于一口价', () => {
    const m = { costPoints: 0, videoCost: 100, metadata: { perSecondBeans: 2 } }
    expect(planNodeCharge('VIDEO', m, { durationSec: 3 })).toEqual({ points: 0, beans: 6 })
  })

  it('VIDEO 只有按秒价但没给时长 → 回退一口价（可能为 0）', () => {
    const m = { costPoints: 0, videoCost: null, metadata: { perSecondBeans: 2 } }
    expect(planNodeCharge('VIDEO', m, {})).toEqual({ points: 0, beans: 0 })
  })

  it('VIDEO 免费模型 → 豆也是 0', () => {
    expect(planNodeCharge('VIDEO', { costPoints: 0, videoCost: 5, isFree: true })).toEqual({ points: 0, beans: 0 })
  })

  it('VIDEO 未配豆价 → 0（不倒扣）', () => {
    expect(planNodeCharge('VIDEO', { costPoints: 0, videoCost: null })).toEqual({ points: 0, beans: 0 })
  })

  it('IMAGE → 走档位价', () => {
    const m = { costPoints: 10, metadata: { tierCost1K: 10, tierCost2K: 20 } }
    expect(planNodeCharge('IMAGE', m, { width: 2048, height: 2048 })).toEqual({ points: 20, beans: 0 })
  })

  it('TEXT / AUDIO / 其它 → 统一价', () => {
    expect(planNodeCharge('TEXT', { costPoints: 3 })).toEqual({ points: 3, beans: 0 })
    expect(planNodeCharge('AUDIO', { costPoints: 7 })).toEqual({ points: 7, beans: 0 })
  })

  it('三条入口同口径：相同输入必得相同结果（杜绝账目分叉）', () => {
    const m = { costPoints: 10, discount: 0.5, metadata: { tierCost1K: 10, tierCost2K: 20 } }
    const a = planNodeCharge('IMAGE', m, { width: 1536, height: 1536 })
    const b = planNodeCharge('IMAGE', m, { width: 1536, height: 1536 })
    expect(a).toEqual(b)
    expect(a.points).toBe(5)
  })
})
