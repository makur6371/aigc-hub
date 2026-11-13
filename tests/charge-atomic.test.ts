import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Q-D01 / Q-D03 原子性契约测试。
 *
 * 锁死两件事：
 *  1. deductRunCharge —— 积分 + 豆两笔预扣必须发生在**同一个** $transaction 里
 *     （以前分两次事务，豆扣失败后已扣积分没有退款路径）；
 *  2. settleHoldWithRefund —— 退差额 + 置 hold SETTLED 必须原子完成
 *     （以前退款 .catch 吞错后 hold 仍被结算，对账兜底永不重试，差额永久丢失）。
 *
 * Prisma 事务本身难以在无 DB 环境验证回滚，这里用 fake tx 验证「同事务、同连接」
 * 这一结构契约；真回滚由 $transaction 语义保证。
 */

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  resolveBillingOwner: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))
vi.mock('@/lib/billing/team', () => ({
  resolveBillingOwner: mocks.resolveBillingOwner,
  getTeamLimitState: vi.fn(),
  addTeamSpend: vi.fn(),
}))

import { deductRunCharge, settleHoldWithRefund } from '@/lib/billing/wallet'

function makeTx(overrides: Partial<Record<string, unknown>> = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u1', points: 100, beans: 100 }) },
    pointsLog: { create: vi.fn().mockResolvedValue({}) },
    beansLog: { create: vi.fn().mockResolvedValue({}) },
    billingHold: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ...overrides,
  }
  return tx
}

/** $transaction 直接执行回调（单实例语义等价：全部走同一个 tx，任一抛错即整体 reject） */
function makePrisma(tx: ReturnType<typeof makeTx>, transactionShouldReject = false) {
  return {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (transactionShouldReject) throw new Error('transaction aborted')
      return fn(tx)
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveBillingOwner.mockResolvedValue({ ownerId: null, isTeam: false })
})

describe('deductRunCharge —— 积分与豆同一事务预扣（Q-D01）', () => {
  it('两笔扣减走同一个 $transaction（同一 tx 对象）', async () => {
    const tx = makeTx()
    mocks.getPrisma.mockResolvedValue(makePrisma(tx))

    await deductRunCharge({ userId: 'u1', points: 5, beans: 3, description: '生成扣费', runId: 'run-1' })

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
    expect(tx.pointsLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -5 }) }))
    expect(tx.beansLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -3 }) }))
  })

  it('任一笔失败 → 错误从同一个 $transaction 上抛（真事务语义下两笔一起回滚）', async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)
    // 第一笔（积分）成功，第二笔（豆）条件扣减命中 0 行 → deductBeans 抛「豆不足」
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    mocks.getPrisma.mockResolvedValue(prisma)

    await expect(
      deductRunCharge({ userId: 'u1', points: 5, beans: 3, description: '生成扣费' }),
    ).rejects.toThrow(/豆不足/)

    // 结构契约：两笔扣减发生在同一次事务调用里（fn 内抛错 → Prisma 整体回滚），
    // 而不是「积分一笔事务 + 豆一笔事务」——后者才是 Q-D01 的资损根因。
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('单币种调用也只开一个事务；0/0 直接短路不开事务', async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)
    mocks.getPrisma.mockResolvedValue(prisma)

    await deductRunCharge({ userId: 'u1', points: 0, beans: 0, description: '生成扣费' })
    expect(prisma.$transaction).not.toHaveBeenCalled()

    await deductRunCharge({ userId: 'u1', points: 0, beans: 3, description: '生成扣费' })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
  })
})

describe('settleHoldWithRefund —— 退差额 + 置 SETTLED 原子收口（Q-D03）', () => {
  it('有差额：两笔退款与 hold 结算在同一个事务里完成', async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx)
    mocks.getPrisma.mockResolvedValue(prisma)

    await settleHoldWithRefund({
      runId: 'run-1',
      userId: 'u1',
      refundPoints: 4,
      refundBeans: 6,
      pointsDescription: '画布取消退款（未消耗部分）',
      beansDescription: '画布视频节点取消退款（未消耗部分）',
    })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.pointsLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 4 }) }))
    expect(tx.beansLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 6 }) }))
    expect(tx.billingHold.updateMany).toHaveBeenCalledWith({
      where: { runId: 'run-1', status: 'OPEN' },
      data: { status: 'SETTLED' },
    })
  })

  it('退款抛错 → 整体失败、hold 不被结算（保持 OPEN 交由对账重试）', async () => {
    const tx = makeTx()
    const prisma = makePrisma(tx, true)
    mocks.getPrisma.mockResolvedValue(prisma)

    await expect(
      settleHoldWithRefund({
        runId: 'run-1',
        userId: 'u1',
        refundPoints: 4,
        refundBeans: 0,
        pointsDescription: '画布失败退款（未消耗部分）',
        beansDescription: '画布视频节点失败退款（未消耗部分）',
      }),
    ).rejects.toThrow()

    expect(tx.billingHold.updateMany).not.toHaveBeenCalled()
  })

  it('零差额：不退款，仍把 hold 置 SETTLED（对齐原 settleHold 行为）', async () => {
    const tx = makeTx()
    mocks.getPrisma.mockResolvedValue(makePrisma(tx))

    await settleHoldWithRefund({
      runId: 'run-1',
      userId: 'u1',
      refundPoints: 0,
      refundBeans: 0,
      pointsDescription: '画布完成退差额',
      beansDescription: '画布视频节点退差额',
    })

    expect(tx.$executeRaw).not.toHaveBeenCalled()
    expect(tx.billingHold.updateMany).toHaveBeenCalledWith({
      where: { runId: 'run-1', status: 'OPEN' },
      data: { status: 'SETTLED' },
    })
  })
})
