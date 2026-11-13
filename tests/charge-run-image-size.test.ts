import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  resolveChargeModel: vi.fn(),
  tryConsumeFreeQuota: vi.fn(),
  releaseFreeQuota: vi.fn(),
  deductRunCharge: vi.fn(),
  refundPoints: vi.fn(),
  deductBeans: vi.fn(),
  refundBeans: vi.fn(),
  resolveAvailableBalance: vi.fn(),
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

describe('chargeRun image size canonicalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveChargeModel.mockResolvedValue({ id: 'img-1' })
    mocks.tryConsumeFreeQuota.mockResolvedValue(false)
    mocks.resolveAvailableBalance.mockResolvedValue({ points: 1000, beans: 1000, isTeam: false })
    mocks.deductRunCharge.mockResolvedValue(undefined)
    mocks.getPrisma.mockResolvedValue({
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'u1', points: 1000, beans: 1000 }) },
      modelConfig: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'img-1',
          name: 'Only 1K',
          modelName: 'only-1k',
          type: 'IMAGE',
          providerId: 'p1',
          provider: { id: 'p1', baseUrl: 'https://example.test', apiKey: 'k', adapterId: null, configJson: null, isActive: true },
          costPoints: 99,
          discount: null,
          isFree: false,
          supportsVision: false,
          metadata: {
            sizes: ['16:9@1K'],
            tierCost1K: 5,
            tierCost4K: 99,
          },
        }),
      },
    })
  })

  it('bills the snapped 1K size instead of the requested unsupported 4K', async () => {
    const run = await chargeRun({
      userId: 'u1',
      modelType: 'IMAGE',
      modelId: 'img-1',
      width: 3840,
      height: 2160,
    })

    expect(run.imageSize).toEqual({ width: 1536, height: 864 })
    expect(run.cost.points).toBe(5)
    expect(mocks.deductRunCharge).toHaveBeenCalledWith(expect.objectContaining({ points: 5, beans: 0 }))
  })
})
