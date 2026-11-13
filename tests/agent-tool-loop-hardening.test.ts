import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  taskStatus: 'RUNNING',
}))

vi.mock('@/lib/prisma', () => ({
  getPrisma: async () => ({
    generationTask: {
      findUnique: async () => ({ status: state.taskStatus }),
    },
    modelConfig: {
      findMany: async () => [{
        id: 'm1', name: 'Mock Image', type: 'IMAGE', costPoints: 1, isFree: true, metadata: null,
      }],
    },
  }),
}))

vi.mock('@/lib/agent-preferences', () => ({
  getAgentPreferences: async () => ({
    imageModelId: null, videoModelId: null, audioModelId: null,
    imageRatio: null, imageTier: null, imageQuality: null,
  }),
}))

vi.mock('@/lib/upstream-image', () => ({
  publicizeReferenceImages: async (urls: string[] | undefined) => urls || [],
}))

vi.mock('@/lib/llm-provider', () => ({
  streamChatToUpstream: vi.fn(),
}))

vi.mock('@/lib/billing/charge-run', () => ({
  ChargeRunError: class ChargeRunError extends Error {},
  chargeRun: vi.fn(),
}))

import { TOOL } from '@/lib/agent-tools'
import { executeAction, runAgentToolLoop } from '@/lib/agent-tool-loop'
import { AgentCancelledError } from '@/lib/agent-cancel'

const emit = () => {}

const baseCtx = (over: Record<string, unknown> = {}) => ({
  emit,
  userId: 'u1',
  taskId: 't1',
  prompt: '画一只猫',
  modelRows: [
    { id: 'm1', name: 'Mock Image', capability: 'image', ratios: '1:1,3:4', tiers: '1K,2K' },
    { id: 'v1', name: 'Mock Video', capability: 'video', ratios: '16:9', resolutions: '720P', durations: '5,10' },
  ],
  poolByAlias: new Map<string, string>(),
  nextGeneratedAssetIndex: 1,
  ...over,
})

beforeEach(() => {
  state.taskStatus = 'RUNNING'
})

describe('Agent 执行层硬化', () => {
  it('本轮新生成的图立即注册为素材，下一轮可继续引用', async () => {
    const ctx = baseCtx()
    const first = await executeAction({
      name: TOOL.generateImage,
      args: { prompt: '主图', title: '主图', model: 'm1', ratio: '1:1', tier: '1K' },
      nextIndex: 0,
      ctx: ctx as never,
      runDeliverable: async () => ({
        result: { imageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'] },
        cost: 2,
        beans: 0,
      }),
    })

    expect(first.subtask).toMatchObject({
      status: 'success',
      assetAliases: ['素材1', '素材2'],
    })
    expect(ctx.poolByAlias.get('素材1')).toBe('https://cdn.example/1.png')
    expect(ctx.poolByAlias.get('素材2')).toBe('https://cdn.example/2.png')

    let seenAssetIds: string[] | undefined
    const second = await executeAction({
      name: TOOL.generateImage,
      args: { prompt: '把背景改成白色', title: '改图', model: 'm1', ratio: '1:1', tier: '1K', assetIds: ['素材2'] },
      nextIndex: 1,
      ctx: ctx as never,
      runDeliverable: async (d) => {
        seenAssetIds = d.assetIds
        return { result: { imageUrl: 'https://cdn.example/3.png' }, cost: 1, beans: 0 }
      },
    })

    expect(seenAssetIds).toEqual(['素材2'])
    expect(second.text).toContain('新增可引用素材：素材3')
  })

  it('不存在的素材编号不会送到上游', async () => {
    let called = 0
    const out = await executeAction({
      name: TOOL.generateImage,
      args: { prompt: '改图', model: 'm1', ratio: '1:1', tier: '1K', assetIds: ['素材9'] },
      nextIndex: 0,
      ctx: baseCtx() as never,
      runDeliverable: async () => {
        called++
        return { result: { imageUrl: 'https://cdn.example/x.png' }, cost: 1, beans: 0 }
      },
    })

    expect(called).toBe(0)
    expect(out.text).toContain('不在本会话素材池中')
  })

  it('模型不支持的图片比例/档位会回填给模型自纠', async () => {
    let called = 0
    const out = await executeAction({
      name: TOOL.generateImage,
      args: { prompt: '海报', model: 'm1', ratio: '16:9', tier: '4K' },
      nextIndex: 0,
      ctx: baseCtx() as never,
      runDeliverable: async () => {
        called++
        return { result: { imageUrl: 'https://cdn.example/x.png' }, cost: 1, beans: 0 }
      },
    })

    expect(called).toBe(0)
    expect(out.text).toContain('不支持比例 16:9')
    expect(out.text).toContain('可用比例：1:1,3:4')
  })

  it('视频时长必须落在模型声明的可选范围内', async () => {
    let called = 0
    const out = await executeAction({
      name: TOOL.generateVideo,
      args: { prompt: '镜头推进', model: 'v1', ratio: '16:9', resolution: '720P', seconds: 15 },
      nextIndex: 0,
      ctx: baseCtx() as never,
      runDeliverable: async () => {
        called++
        return { result: { videoUrl: 'https://cdn.example/v.mp4' }, cost: 0, beans: 5 }
      },
    })

    expect(called).toBe(0)
    expect(out.text).toContain('不支持 15 秒')
    expect(out.text).toContain('可用时长：5,10')
  })

  it('任务已取消时，工具循环在调用规划模型前停止', async () => {
    state.taskStatus = 'CANCELLED'

    await expect(runAgentToolLoop({
      emit,
      userId: 'u1',
      taskId: 't1',
      prompt: '画猫',
      candidates: [{
        id: 'b1', name: 'Brain', modelName: 'brain', type: 'TEXT',
        provider: { baseUrl: 'https://x', apiKey: 'k' },
      }],
      runDeliverable: async () => {
        throw new Error('不应执行')
      },
    })).rejects.toBeInstanceOf(AgentCancelledError)
  })
})
