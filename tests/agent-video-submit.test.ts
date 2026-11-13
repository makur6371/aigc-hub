import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDeliverable } from '@/lib/agent-executor'

const fixture = vi.hoisted(() => ({ generate: vi.fn(), create: vi.fn(), charge: vi.fn(), defer: vi.fn(), settle: vi.fn() }))
vi.mock('@/lib/media-provider', () => ({ generateVideo: fixture.generate, generateImage: vi.fn() }))
vi.mock('@/lib/agent-cancel', () => ({ assertAgentTaskActive: vi.fn(), AgentCancelledError: class extends Error {} }))
vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({
  user: { findUnique: async () => ({ points: 100, beans: 1000 }) },
  modelConfig: { findUnique: async () => ({ id: 'video', type: 'VIDEO', provider: { apiKey: 'mock' }, metadata: {} }) },
  videoGenerationRecord: { create: fixture.create },
}) }))
vi.mock('@/lib/billing/charge-run', () => ({ chargeRun: fixture.charge, ChargeRunError: class extends Error {} }))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.create.mockImplementation(async () => ({ id: `record-${fixture.create.mock.calls.length}` }))
  fixture.charge.mockResolvedValue({
    cost: { beans: 100, points: 0 },
    model: { id: 'video', modelName: 'H3', baseUrl: 'https://example.com', apiKey: 'mock', metadata: {} },
    execute: async (run: () => Promise<unknown>) => run(), defer: fixture.defer, settle: fixture.settle,
  })
})

describe('Agent 视频异步提交协议', () => {
  it('提交任务号保留全部记录和 deliverableId，并把任务号关联到 202 日志', async () => {
    fixture.generate.mockResolvedValueOnce({ taskId: 'upstream-1', pollPath: '/status' }).mockResolvedValueOnce({ taskId: 'upstream-2' })
    const events: Record<string, unknown>[] = []
    const out = await runDeliverable({ id: 'clip', type: 'video', model: 'video', prompt: '产品展示', title: '展示', count: 2 },
      { userId: 'user', taskId: 'parent', prompt: '展示', emit: (event) => { events.push(event) } })
    expect(out.result).toMatchObject({ videoPending: true, pendingRecordIds: ['record-1', 'record-2'] })
    expect(events.filter((event) => event.type === 'pendingVideo')).toEqual([
      expect.objectContaining({ deliverableId: 'clip', recordId: 'record-1', index: 0 }),
      expect.objectContaining({ deliverableId: 'clip', recordId: 'record-2', index: 1 }),
    ])
    expect(fixture.charge).toHaveBeenCalledTimes(1)
    expect(fixture.create.mock.calls.map(([input]) => input.data.beansCost)).toEqual([50, 50])
    expect(fixture.defer).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'upstream-1' }))
    expect(fixture.settle).not.toHaveBeenCalled()
  })

  it('直出视频带视频类型和精确占位身份，走真实成功结算', async () => {
    fixture.generate.mockResolvedValueOnce({ videoUrl: 'https://example.com/clip.mp4' })
    const events: Record<string, unknown>[] = []
    const out = await runDeliverable({ id: 'clip', type: 'video', model: 'video', prompt: '展示', title: '展示' },
      { userId: 'user', taskId: 'parent', prompt: '展示', emit: (event) => { events.push(event) } })
    expect(out.result.videoPending).toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ type: 'media', kind: 'video', deliverableId: 'clip', index: 0 }))
    expect(fixture.settle).toHaveBeenCalledTimes(1)
    expect(fixture.defer).not.toHaveBeenCalled()
  })
})
