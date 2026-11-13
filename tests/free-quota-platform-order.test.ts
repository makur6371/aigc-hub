import { describe, expect, it } from 'vitest'
import { tryConsumeFreeQuota } from '@/lib/free-quota'

/**
 * Q-D10：平台免费额度的并发超发防线 —— 「先写后读 + 同事务补偿退回」。
 *
 * 老实现先 aggregate 平台总量、再 bump 用户行：两个并发事务都能读到旧快照、双双通过，
 * 平台额度被小幅超发。现在用户占位是事务第一条写语句（WAL 下写锁伴随最新快照），
 * 平台总量在其后读取；超限则同事务 decrement 退回本次占位并返回 false。
 * 这里显式传 tx，无需 mock 全局 prisma，直接锁事务内的调用顺序与补偿行为。
 */

const model = {
  id: 'm1',
  dailyUserFreeQuota: 5,
  dailyPlatformFreeQuota: 10,
  metadata: {},
}

type Call = { op: string; data?: unknown }
type FakeData = { count?: { increment?: number; decrement?: number } }

function makeTx(platformSumAfterMyBump: number) {
  const calls: Call[] = []
  const tx = {
    modelFreeQuotaUsage: {
      updateMany: async (arg: { where: Record<string, unknown>; data: FakeData }) => {
        calls.push({ op: 'updateMany', data: arg.data })
        // 占位（increment）与补偿（decrement）都命中行 —— 本测试只关心调用顺序与参数
        return { count: 1 }
      },
      aggregate: async () => {
        calls.push({ op: 'aggregate' })
        return { _sum: { count: platformSumAfterMyBump } }
      },
      create: async () => {
        calls.push({ op: 'create' })
        return {}
      },
    },
  }
  // 测试用最小事务替身：只实现被测路径用到的 delegate
  return { tx, calls }
}

describe('tryConsumeFreeQuota 平台额度顺序防线（Q-D10）', () => {
  it('先占用户额度（写），再读平台总量 —— 顺序不可颠倒', async () => {
    const { tx, calls } = makeTx(5)
    const ok = await tryConsumeFreeQuota(model, 'u1', null, tx as never)
    expect(ok).toBe(true)
    expect(calls.map((c) => c.op)).toEqual(['updateMany', 'aggregate'])
  })

  it('平台总量已超（含本次占位）→ 同事务退回并返回 false', async () => {
    const { tx, calls } = makeTx(11)
    const ok = await tryConsumeFreeQuota(model, 'u1', null, tx as never)
    expect(ok).toBe(false)
    expect(calls.map((c) => c.op)).toEqual(['updateMany', 'aggregate', 'updateMany'])
    // 第三次调用必须是退回（decrement 1），不是再次占用
    expect(calls[2].data).toEqual({ count: { decrement: 1 } })
  })

  it('平台总量刚好等于上限（本次是最后一个名额）→ 放行，不退回', async () => {
    const { tx, calls } = makeTx(10)
    const ok = await tryConsumeFreeQuota(model, 'u1', null, tx as never)
    expect(ok).toBe(true)
    expect(calls.filter((c) => c.op === 'updateMany')).toHaveLength(1)
  })
})
