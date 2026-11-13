import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Q-603：平台级订阅到期回滚。
 *
 * 锁死两件事：
 *  1. 谓词与单用户版 `checkSubscriptionExpiry` **完全一致**（含「历史遗留无到期时间也回滚」），
 *     两处各写一套判断迟早漂移 —— 这个仓库已经因「两份对账实现漂移」出过账实不符；
 *  2. 只回滚真正到期的，绝不把未过期账号一起改掉（那会直接吞掉用户权益）。
 */

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))
vi.mock('@/lib/billing/team', () => ({
  resolveBillingOwner: vi.fn(),
  getTeamLimitState: vi.fn(),
  addTeamSpend: vi.fn(),
}))
vi.mock('@/lib/invite/policy', () => ({ createInviteRewardForOrder: vi.fn() }))

import { checkSubscriptionExpiry, expireDueSubscriptions } from '@/lib/billing/wallet'

type Where = Record<string, unknown>

function fakePrisma(updated: Where[] = []) {
  const seen: Where[] = []
  return {
    seen,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: {
          updateMany: async ({ where }: { where: Where }) => {
            seen.push(where)
            return { count: updated.length }
          },
        },
      }),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('expireDueSubscriptions', () => {
  it('回滚条件覆盖「已过期」与「无到期时间」两种，且限定 billingType=SUBSCRIPTION', async () => {
    const p = fakePrisma()
    mocks.getPrisma.mockResolvedValue(p)
    const n = await expireDueSubscriptions()
    expect(n).toBe(0)
    const where = p.seen[0]
    expect(where.billingType).toBe('SUBSCRIPTION')
    const or = where.OR as Array<Record<string, unknown>>
    expect(or.map((c) => Object.keys(c)[0])).toEqual(['subscriptionExpiryAt', 'subscriptionExpiryAt'])
    expect(or[1]).toEqual({ subscriptionExpiryAt: null })
  })

  it('谓词与单用户惰性检查一致（同一套条件，只多一个 id 限定）', async () => {
    const p1 = fakePrisma()
    const p2 = fakePrisma()
    mocks.getPrisma.mockResolvedValue(p1)
    await checkSubscriptionExpiry('u1')
    mocks.getPrisma.mockResolvedValue(p2)
    await expireDueSubscriptions()

    const single = p1.seen[0]
    const sweep = p2.seen[0]
    const shape = (w: Where) => ({
      billingType: w.billingType,
      // 到期时刻是 new Date()，两次调用不可能完全相等，只比结构与「是否为时间比较」
      orKeys: (w.OR as Array<Record<string, unknown>>).map((c) => {
        const v = c.subscriptionExpiryAt
        if (v === null) return 'null'
        return typeof v === 'object' && v !== null && 'lt' in (v as Record<string, unknown>) ? 'lt:Date' : '?'
      }),
    })
    expect(single.id).toBe('u1')
    expect(sweep.id).toBeUndefined()
    expect(shape(sweep)).toEqual(shape(single))
    expect(shape(sweep)).toEqual({ billingType: 'SUBSCRIPTION', orKeys: ['lt:Date', 'null'] })
  })

  it('返回被回滚的账号数（供维护结果与日志使用）', async () => {
    mocks.getPrisma.mockResolvedValue(fakePrisma([{}, {}, {}]))
    await expect(expireDueSubscriptions()).resolves.toBe(3)
  })
})
