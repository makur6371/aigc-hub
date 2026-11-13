import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))

import {
  checkFreeImagePass,
  clearFreeImagePassPolicyCache,
  consumeFreeImagePass,
  getFreeImagePassPolicy,
  releaseFreeImagePass,
} from '@/lib/promotions/free-image-pass'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-11-10T12:00:00+08:00')
const model = { id: 'img-1', type: 'IMAGE', dailyUserFreeQuota: 10 }
const entitledUser = { freeImageUntil: new Date(now.getTime() + DAY) }
const videoModel = { id: 'v-1', type: 'VIDEO', dailyUserFreeQuota: 10 }

function makePrisma(policy: { enabled: boolean; dailyUserLimit: number; dailyPlatformLimit: number; modelIds?: string[] | null } | null, userUsed = 0, platformUsed = 0) {
  const usage = {
    count: vi.fn().mockImplementation(async ({ where }: { where: { userId?: string } }) =>
      where.userId ? userUsed : platformUsed),
    create: vi.fn().mockResolvedValue({ id: 'usage-1' }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    freeImagePassPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy ? { id: 'primary', ...policy } : null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(policy ?? { enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0 }),
    },
    freeImagePassUsage: usage,
  }
  return { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearFreeImagePassPolicyCache()
})

describe('生图时长券限额与台账', () => {
  it('没有时长券 / 非覆盖模型 / 视频都不免费，且不查限额表', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 5, dailyPlatformLimit: 50 })
    mocks.getPrisma.mockResolvedValue(prisma)

    expect((await checkFreeImagePass(model, {}, 'u1', now)).free).toBe(false)
    expect((await checkFreeImagePass({ ...model, dailyUserFreeQuota: 0 }, entitledUser, 'u1', now)).free).toBe(false)
    expect((await checkFreeImagePass(videoModel, entitledUser, 'u1', now)).free).toBe(false)
    expect(prisma.freeImagePassUsage.count).not.toHaveBeenCalled()
  })

  it('两个上限都是 0 时不限次，但仍写台账用于统计', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0 })
    mocks.getPrisma.mockResolvedValue(prisma)
    const res = await consumeFreeImagePass({ model, user: entitledUser, userId: 'u1', now })
    expect(res.free).toBe(true)
    expect(res.usageIds).toEqual(['usage-1'])
    expect(prisma.freeImagePassUsage.create).toHaveBeenCalledTimes(1)
  })

  it('用户每日上限用满后不再免费，且不会写台账', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 2, dailyPlatformLimit: 0 }, 2, 0)
    mocks.getPrisma.mockResolvedValue(prisma)

    const check = await checkFreeImagePass(model, entitledUser, 'u1', now)
    expect(check.free).toBe(false)
    expect(check.reason).toBe('user-limit')
    expect(check.userRemaining).toBe(0)

    const res = await consumeFreeImagePass({ model, user: entitledUser, userId: 'u1', now })
    expect(res.free).toBe(false)
    expect(prisma.freeImagePassUsage.create).not.toHaveBeenCalled()
  })

  it('平台每日上限用满后所有人都不免费', async () => {
    mocks.getPrisma.mockResolvedValue(makePrisma({ enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 100 }, 0, 100))
    const res = await checkFreeImagePass(model, entitledUser, 'u1', now)
    expect(res.free).toBe(false)
    expect(res.reason).toBe('platform-limit')
  })

  it('总开关关闭后，已领取的券也不再生效', async () => {
    mocks.getPrisma.mockResolvedValue(makePrisma({ enabled: false, dailyUserLimit: 0, dailyPlatformLimit: 0 }))
    const res = await checkFreeImagePass(model, entitledUser, 'u1', now)
    expect(res.free).toBe(false)
    expect(res.reason).toBe('disabled')
  })

  it('有名额时写台账，失败可归还', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 5, dailyPlatformLimit: 0 }, 0, 0)
    mocks.getPrisma.mockResolvedValue(prisma)

    const res = await consumeFreeImagePass({ model, user: entitledUser, userId: 'u1', source: 'api', runId: 'run-1', now })
    expect(res.free).toBe(true)
    expect(res.usageIds).toEqual(['usage-1'])
    expect(prisma.freeImagePassUsage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', modelId: 'img-1', source: 'api', runId: 'run-1' }),
    }))

    await releaseFreeImagePass('usage-1')
    expect(prisma.freeImagePassUsage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['usage-1'] } } })
  })

  it('批量产出按份数占名额（一次 3 张就扣 3 张）', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 10, dailyPlatformLimit: 0 }, 0, 0)
    mocks.getPrisma.mockResolvedValue(prisma)

    const res = await consumeFreeImagePass({ model, user: entitledUser, userId: 'u1', units: 3, now })
    expect(res.free).toBe(true)
    expect(prisma.freeImagePassUsage.create).toHaveBeenCalledTimes(3)
  })

  it('剩余名额不够一次批量时，整体按正常价计费', async () => {
    const prisma = makePrisma({ enabled: true, dailyUserLimit: 5, dailyPlatformLimit: 0 }, 3, 0)
    mocks.getPrisma.mockResolvedValue(prisma)

    const res = await consumeFreeImagePass({ model, user: entitledUser, userId: 'u1', units: 3, now })
    expect(res.free).toBe(false)
    expect(prisma.freeImagePassUsage.create).not.toHaveBeenCalled()
  })

  it('策略行缺失时回落为「启用 + 不限次」', async () => {
    mocks.getPrisma.mockResolvedValue(makePrisma(null))
    const policy = await getFreeImagePassPolicy()
    expect(policy).toEqual({ enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0, modelIds: null })
  })

  it('独立覆盖模型不随免费池改变，空列表不覆盖任何模型', async () => {
    mocks.getPrisma.mockResolvedValue(makePrisma({ enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0, modelIds: ['img-1'] }))
    expect((await checkFreeImagePass({ ...model, dailyUserFreeQuota: 0 }, entitledUser, 'u1', now)).free).toBe(true)
    expect((await checkFreeImagePass({ ...model, id: 'other' }, entitledUser, 'u1', now)).free).toBe(false)
    clearFreeImagePassPolicyCache()
    mocks.getPrisma.mockResolvedValue(makePrisma({ enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0, modelIds: [] }))
    expect((await checkFreeImagePass(model, entitledUser, 'u1', now)).free).toBe(false)
  })

  it('读取策略失败不能降级为不限次', async () => {
    const prisma = makePrisma(null)
    prisma.freeImagePassPolicy.findUnique.mockRejectedValue(new Error('database unavailable'))
    mocks.getPrisma.mockResolvedValue(prisma)
    await expect(checkFreeImagePass(model, entitledUser, 'u1', now)).rejects.toThrow('database unavailable')
  })
})
