import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * confirm 确认执行必须重建会话素材池（硬化清单 §3.4）。
 *
 * 事故形状：poolByAlias（图片N/素材N → 公网 URL）是规划期的内存对象，不随
 * pendingActions 落库。确认执行是新的调用，若不重建，pendingActions 里
 * assetIds:["图片1"] 在 resolveReferenceImages 查不到 → 图生图静默退化成文生图。
 *
 * 这里用 mock 验证：executePendingActions 在有 sessionId 时必须调用
 * loadSessionAssetPool 重建池子，并把解析表传进执行 ctx。
 */

const mocks = vi.hoisted(() => ({
  loadSessionAssetPool: vi.fn(),
  publicizeReferenceImages: vi.fn(),
  getPrisma: vi.fn(),
  generateImage: vi.fn(),
}))

vi.mock('@/lib/agent-asset-pool', () => ({
  loadSessionAssetPool: mocks.loadSessionAssetPool,
}))
vi.mock('@/lib/upstream-image', () => ({
  publicizeReferenceImages: mocks.publicizeReferenceImages,
}))
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))
vi.mock('@/lib/media-provider', () => ({
  generateImage: mocks.generateImage,
  generateVideo: vi.fn(),
}))
vi.mock('@/lib/billing/charge-run', () => ({
  chargeRun: vi.fn().mockResolvedValue({
    cost: { points: 1, beans: 0 },
    usedFreeQuota: false,
    model: {
      id: 'm1', name: 'img', modelName: 'img', type: 'IMAGE',
      baseUrl: 'https://x', apiKey: 'k', adapterId: null,
      configJson: null, metadata: null, supportsVision: false,
    },
    execute: async <T,>(fn: () => Promise<T>) => fn(),
    settle: vi.fn(),
    fail: vi.fn(),
    defer: vi.fn(),
  }),
  ChargeRunError: class extends Error {},
}))
vi.mock('@/lib/concurrency', () => ({
  withGatePhaseReporter: (_phase: unknown, fn: () => unknown) => fn(),
}))

import { executePendingActions } from '@/lib/agent-executor'

describe('executePendingActions —— confirm 确认执行重建素材池', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // prisma: user 查询返回余额；执行成功走 image 分支
    mocks.getPrisma.mockResolvedValue({
      user: { findUnique: vi.fn().mockResolvedValue({ points: 1000, beans: 1000 }) },
      modelConfig: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'm1', name: 'img', modelName: 'img', type: 'IMAGE',
          supportsVision: false, metadata: null,
          provider: { baseUrl: 'https://x', apiKey: 'k', adapterId: null, configJson: null },
        }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    })
    mocks.publicizeReferenceImages.mockImplementation(async (urls: string[]) =>
      urls.map((u) => (u.startsWith('http') ? u : `https://site.test${u}`)))
    mocks.generateImage.mockResolvedValue({ imageUrl: 'https://up/x.png' })
  })

  const baseOpts = () => ({
    userId: 'u1',
    taskId: 't1',
    prompt: '基于我的图再改一版',
    images: [] as string[],
    sessionId: 'sess1' as string | null,
    params: {},
    defaultTier: '1K',
    emit: () => {},
  })

  const imageAction = {
    id: 'task-0', kind: 'image' as const, title: '主图', modelId: 'm1',
    prompt: '基于上传图重绘', count: 1, assetIds: ['图片1'],
  }

  it('有 sessionId 时重建池子，并把 poolByAlias 传进执行 ctx', async () => {
    mocks.loadSessionAssetPool.mockResolvedValue({
      uploaded: [{ alias: '图片1', url: '/api/asset/a.png', type: 'image' }],
      generated: [],
    })

    await executePendingActions({ ...baseOpts(), pendingActions: [imageAction] })

    expect(mocks.loadSessionAssetPool).toHaveBeenCalledWith('sess1')
    // 图片1 的 url 被公网化 → 说明池子表真的构建并传进了 ctx
    // 关键断言：上游收到的 referenceImages 是**公网化后的池子 URL**，
    // 而不是 undefined（文生图）。若 ctx 没带 poolByAlias，assetIds 解析失败
    // → generateImage 的 referenceImages 为 undefined → 图生图静默退化。
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: ['https://site.test/api/asset/a.png'],
      }),
    )
  })

  it('无 sessionId 时不触发池子重建（没有会话就没有池子可言）', async () => {
    await executePendingActions({ ...baseOpts(), sessionId: null, pendingActions: [imageAction] })
    expect(mocks.loadSessionAssetPool).not.toHaveBeenCalled()
  })

  it('池子加载失败不阻断执行（退化为旧行为：本轮上传图兜底）', async () => {
    mocks.loadSessionAssetPool.mockRejectedValue(new Error('db down'))
    const out = await executePendingActions({ ...baseOpts(), pendingActions: [imageAction] })
    // 不抛错，任务照常推进（成功或失败都行，但必须有 subtask 输出）
    expect(out.subtasks.length).toBe(1)
  })
})
