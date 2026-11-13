import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 并发派发回归 —— 用户反馈"生成 6 套电商图变成一张一张挤"。
 *
 * 两个串行瓶颈：
 *   1) runDeliverable 里按 count 逐张 await（已在 agent-executor 修，此处不覆盖）
 *   2) 循环里同一轮**只取第一个** tool_call → 6 个方向要等 6 轮，每轮等生成完
 * 本文件锁死第 2 个：同轮多个 generate_image 必须并发派发，不能串行。
 */

const chatResponses: unknown[] = []
let chatIndex = 0

vi.mock('@/lib/prisma', () => ({
  getPrisma: async () => ({
    modelConfig: { findMany: async () => [{ id: 'm1', name: 'Mock Image', type: 'IMAGE', costPoints: 1, isFree: true, metadata: null }] },
    generationTask: { findUnique: async () => ({ status: 'RUNNING' }) },
  }),
}))
vi.mock('@/lib/llm-provider', () => ({
  streamChatToUpstream: async () => {
    const r = chatResponses[Math.min(chatIndex, chatResponses.length - 1)]
    chatIndex++
    return r
  },
}))
vi.mock('@/lib/billing/charge-run', () => ({
  ChargeRunError: class extends Error {},
  chargeRun: async () => ({
    cost: { points: 0, beans: 0 }, usedFreeQuota: false,
    execute: (fn: () => Promise<unknown>) => fn(),
    settle: async () => {}, fail: async () => '', defer: async () => {},
  }),
}))
vi.mock('@/lib/agent-preferences', () => ({
  getAgentPreferences: async () => ({ imageModelId: 'm1', videoModelId: null, audioModelId: null, imageRatio: '3:4', imageTier: '2K', imageQuality: null }),
}))
vi.mock('@/lib/upstream-image', () => ({ publicizeReferenceImages: async (v: string[] | undefined) => v || [] }))

import { runAgentToolLoop } from '@/lib/agent-tool-loop'

const brain = { id: 'b1', name: 'Brain', modelName: 'brain-x', type: 'TEXT', supportsVision: false,
  provider: { baseUrl: 'https://x', apiKey: 'k', adapterId: null, configJson: null } }

const imgCall = (id: string, title: string) => ({
  content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
  toolCalls: [{ id, name: 'generate_image', arguments: JSON.stringify({ prompt: title, title, ratio: '1:1' }) }],
})

beforeEach(() => { chatResponses.length = 0; chatIndex = 0 })

describe('同轮多渠道并发派发', () => {
  it('一轮 6 个 generate_image → 6 个同时开跑（不是串行）', async () => {
    const six = imgCall('c0', '方向1')
    chatResponses.push(
      { ...six, toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: 'generate_image', arguments: JSON.stringify({ prompt: `方向${i}`, title: `方向${i}` }) })) },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'f1', name: 'finish', arguments: '{"summary":"done"}' }] },
    )

    let inflight = 0
    let maxInflight = 0
    const started: string[] = []

    const out = await runAgentToolLoop({
      emit: () => {}, userId: 'u1', taskId: 't1', prompt: '出 6 套图',
      candidates: [brain as never],
      runDeliverable: async (d) => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        started.push(d.title)
        // 模拟生成耗时：若是串行，maxInflight 只会是 1
        await new Promise((r) => setTimeout(r, 30))
        inflight--
        return { result: { imageUrl: `https://x/${d.title}.png` }, cost: 1, beans: 0 }
      },
    })

    expect(out.subtasks).toHaveLength(6)
    expect(started).toHaveLength(6)
    // 关键断言：峰值并发 > 1（串行实现这里恒为 1）
    expect(maxInflight).toBeGreaterThan(1)
    expect(out.finished).toBe(true)
    // turns 是「模型循环轮次」，不是媒体数量：一轮 6 张 + 一轮 finish = 2 轮。
    expect(out.turns).toBe(2)
  })

  it('ask_user 与 generate_image 同轮时，只执行 ask_user（终止动作优先）', async () => {
    chatResponses.push({
      content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
      toolCalls: [
        { id: 'a1', name: 'ask_user', arguments: '{"questions":[{"question":"要几张？"}]}' },
        { id: 'g1', name: 'generate_image', arguments: '{"prompt":"不该被派发"}' },
      ],
    })
    let called = 0
    const out = await runAgentToolLoop({
      emit: () => {}, userId: 'u1', taskId: 't1', prompt: 'x',
      candidates: [brain as never],
      runDeliverable: async () => { called++; return { result: {}, cost: 0, beans: 0 } },
    })
    expect(called).toBe(0)
    expect(out.askQuestions![0].question).toBe('要几张？')
    expect(out.finished).toBe(true)
  })

  it('同轮多个失败：各自回填失败原因，不互相影响', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [
          { id: 'c0', name: 'generate_image', arguments: '{"prompt":"好的","title":"好"}' },
          { id: 'c1', name: 'generate_image', arguments: '{"prompt":"坏的","title":"坏"}' },
        ] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'f', name: 'finish', arguments: '{"summary":"done"}' }] },
    )
    const out = await runAgentToolLoop({
      emit: () => {}, userId: 'u1', taskId: 't1', prompt: 'x',
      candidates: [brain as never],
      runDeliverable: async (d) => {
        if (d.title === '坏') throw new Error('上游 500')
        return { result: { imageUrl: 'https://x/a.png' }, cost: 1, beans: 0 }
      },
    })
    const byTitle = Object.fromEntries(out.subtasks.map((s) => [s.title, s.status]))
    expect(byTitle['好']).toBe('success')
    expect(byTitle['坏']).toBe('failed')
    expect(out.subtasks).toHaveLength(2)
  })
})
