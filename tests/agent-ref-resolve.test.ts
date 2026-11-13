import { describe, it, expect, vi } from 'vitest'

/** 避免引入整条重依赖链：把 executor 的依赖打桩 */
vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({}) }))
vi.mock('@/lib/llm-provider', () => ({ streamChatToUpstream: async () => ({}) }))
vi.mock('@/lib/media-provider', () => ({ generateImage: async () => ({}), generateVideo: async () => ({}) }))
vi.mock('@/lib/billing/charge-run', () => ({ chargeRun: async () => ({}), ChargeRunError: class extends Error {} }))
vi.mock('@/lib/billing/wallet', () => ({ refundBeans: async () => {} }))
vi.mock('@/lib/concurrency', () => ({ withGatePhaseReporter: (_r: unknown, fn: () => unknown) => fn() }))
vi.mock('@/lib/agent-config', () => ({ getAgentConfig: async () => ({ planningModelId: null }) }))
vi.mock('@/lib/agent-preferences', () => ({ getAgentPreferences: async () => ({}) }))
vi.mock('@/lib/agent-skills', () => ({ getAgentSkills: () => [], appendSkillFragments: (s: string) => s }))
vi.mock('@/lib/upstream-image', () => ({ publicizeReferenceImages: async (v: string[] = []) => v }))

import { resolveReferenceImages } from '@/lib/agent-executor'

/**
 * assetIds 的编号解析 —— 跨轮指代的最后一环。
 *
 * 「素材N」是本会话已生成的图（跨轮可用），「图片N」是本会话上传的图。
 * 解析不出来的才退回「本轮上传图序号」，保证旧写法（只传数字）不坏。
 */
const ctx = (over: Record<string, unknown> = {}) => ({
  emit: () => {}, userId: 'u', taskId: 't', prompt: 'p',
  images: ['https://upload/1.png', 'https://upload/2.png'],
  ...over,
}) as never

describe('resolveReferenceImages —— 会话素材池编号', () => {
  it('「素材N」解析到本会话已生成的图（跨轮复用）', () => {
    const pool = new Map([['素材1', 'https://gen/1.png'], ['素材2', 'https://gen/2.png']])
    const out = resolveReferenceImages({ type: 'image', title: 'x', prompt: 'p', assetIds: ['素材2'] } as never, ctx({ poolByAlias: pool }))
    expect(out).toEqual(['https://gen/2.png'])
  })

  it('「图片N」优先走池子（可引用本会话更早那轮的上传图）', () => {
    const pool = new Map([['图片1', 'https://older/turn1.png'], ['图片2', 'https://older/turn2.png']])
    const out = resolveReferenceImages({ type: 'image', title: 'x', prompt: 'p', assetIds: ['图片2'] } as never, ctx({ poolByAlias: pool }))
    expect(out).toEqual(['https://older/turn2.png'])
  })

  it('池子查不到时退回「本轮上传图序号」（旧行为不坏）', () => {
    const out = resolveReferenceImages({ type: 'image', title: 'x', prompt: 'p', assetIds: ['2'] } as never, ctx())
    expect(out).toEqual(['https://upload/2.png'])
  })

  it('未指定 assetIds → 用本轮全部上传图', () => {
    const out = resolveReferenceImages({ type: 'image', title: 'x', prompt: 'p' } as never, ctx())
    expect(out).toEqual(['https://upload/1.png', 'https://upload/2.png'])
  })

  it('没有池子也没有上传图 → undefined（走纯文生图）', () => {
    const out = resolveReferenceImages({ type: 'image', title: 'x', prompt: 'p', assetIds: ['素材1'] } as never, ctx({ images: undefined }))
    expect(out).toBeUndefined()
  })
})
