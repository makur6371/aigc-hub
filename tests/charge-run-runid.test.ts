import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 计费事务号（Q-D09 前置）：任何调用方的扣费都必须可追溯。
 *
 * 生产只读体检查到「直连路径 runId 为空」导致孤儿扣费审计完全测不出真实暴露
 * （30 天 13 笔无从关联）。修法是在 chargeRun 内兜底生成一个号，
 * 而不是去改 11 个调用方 —— 因为 pointsLog / beansLog / apiUsageLog 三处都是它写的。
 * 这里锁死三件事：① 一定有号；② 三处是同一个号；③ 调用方传的号优先（并做 trim）。
 */

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  resolveChargeModel: vi.fn(),
  tryConsumeFreeQuota: vi.fn(),
  releaseFreeQuota: vi.fn(),
  deductRunCharge: vi.fn(),
  refundPoints: vi.fn(),
  refundBeans: vi.fn(),
  resolveAvailableBalance: vi.fn(),
  apiUsageLogCreate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))
vi.mock('@/lib/model-catalog', () => ({ resolveChargeModel: mocks.resolveChargeModel }))
vi.mock('@/lib/free-quota', () => ({
  tryConsumeFreeQuota: mocks.tryConsumeFreeQuota,
  releaseFreeQuota: mocks.releaseFreeQuota,
}))
vi.mock('@/lib/billing/wallet', () => ({
  deductRunCharge: mocks.deductRunCharge,
  refundPoints: mocks.refundPoints,
  refundBeans: mocks.refundBeans,
}))
vi.mock('@/lib/billing/team', () => ({ resolveAvailableBalance: mocks.resolveAvailableBalance }))

import { chargeRun } from '@/lib/billing/charge-run'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveChargeModel.mockResolvedValue({ id: 'img-1' })
  mocks.tryConsumeFreeQuota.mockResolvedValue(false)
  mocks.resolveAvailableBalance.mockResolvedValue({ points: 1000, beans: 1000, isTeam: false })
  mocks.deductRunCharge.mockResolvedValue(undefined)
  mocks.refundPoints.mockResolvedValue(undefined)
  mocks.apiUsageLogCreate.mockResolvedValue({})
  mocks.getPrisma.mockResolvedValue({
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u1', points: 1000, beans: 1000 }) },
    modelConfig: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'img-1',
        name: 'Test Image',
        modelName: 'test-image',
        type: 'IMAGE',
        providerId: 'p1',
        provider: { id: 'p1', baseUrl: 'https://example.test', apiKey: 'k', adapterId: null, configJson: null, isActive: true },
        costPoints: 5,
        discount: null,
        isFree: false,
        supportsVision: false,
        metadata: {},
      }),
    },
    apiUsageLog: { create: mocks.apiUsageLogCreate },
  })
})

describe('chargeRun 计费事务号', () => {
  it('调用方不传 runId 时也一定有号，且扣费流水与调用日志是同一个号', async () => {
    const run = await chargeRun({ userId: 'u1', modelType: 'IMAGE', modelId: 'img-1', source: 'api' })

    expect(typeof run.runId).toBe('string')
    expect(run.runId.length).toBeGreaterThan(10)
    expect(mocks.deductRunCharge).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }))

    await run.settle({ nodeLabel: '图片生成', response: { url: 'https://x/y.png' } })
    expect(mocks.apiUsageLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ runId: run.runId }) }),
    )
  })

  it('调用方传入的 runId 优先（画布/Agent 用自己的任务号串联）', async () => {
    const run = await chargeRun({ userId: 'u1', modelType: 'IMAGE', modelId: 'img-1', runId: 'canvas-run-1' })
    expect(run.runId).toBe('canvas-run-1')
    expect(mocks.deductRunCharge).toHaveBeenCalledWith(expect.objectContaining({ runId: 'canvas-run-1' }))
  })

  it('空白字符串 runId 视为没传（不能把 "" 写进流水，否则 join 仍然失效）', async () => {
    const run = await chargeRun({ userId: 'u1', modelType: 'IMAGE', modelId: 'img-1', runId: '   ' })
    expect(run.runId).not.toBe('   ')
    expect(run.runId.trim().length).toBeGreaterThan(10)
  })

  it('失败退款也带同一个号（扣与退必须能配成对）', async () => {
    const run = await chargeRun({ userId: 'u1', modelType: 'IMAGE', modelId: 'img-1' })
    await run.fail(new Error('上游炸了'), { nodeLabel: '图片生成' })
    expect(mocks.refundPoints).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }))
  })
})
