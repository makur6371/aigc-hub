import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * runAgentToolLoop 的执行期回归（此前完全没测）。
 *
 * 起因（2026-09-30 线上事故）：loop 里 `nameOf` 闭包引用了 `modelRows`，而 `modelRows`
 * 的声明被放在后面，`formatUserPreferencesText` 又是**立即调用** nameOf —— 于是触发
 * const 的 TDZ。生产压缩后变量名变成 H，用户看到「Cannot access 'H' before initialization」。
 * 本地单测没抓到，是因为只测了 executeAction 等纯函数，没有真正跑一遍 loop 主体。
 *
 * 这里用模块 mock 顶掉副作用（DB / 上游 / 计费），只校验 loop 主体能跑通并且行为正确。
 */

const chatResponses: unknown[] = []
let chatIndex = 0

vi.mock('@/lib/prisma', () => ({
  getPrisma: async () => ({
    modelConfig: {
      findMany: async () => [
        { id: 'm1', name: 'Mock Image', type: 'IMAGE', costPoints: 1, isFree: true, metadata: null },
      ],
    },
    generationTask: { findUnique: async () => ({ status: 'RUNNING' }) },
  }),
}))

const capturedPayloads: string[] = []
vi.mock('@/lib/llm-provider', () => ({
  streamChatToUpstream: async (_b: string, _k: string, _m: string, params: { messages?: { content?: string }[] }) => {
    // 记下发给模型的上下文，供「修订意见有没有真的传进去」断言
    const first = params?.messages?.[0]?.content
    if (typeof first === 'string' && first.includes('availableModels')) capturedPayloads.push(first)
    const r = chatResponses[Math.min(chatIndex, chatResponses.length - 1)]
    chatIndex++
    if (r instanceof Error) throw r
    return r
  },
}))

vi.mock('@/lib/billing/charge-run', () => ({
  ChargeRunError: class ChargeRunError extends Error {},
  chargeRun: async () => ({
    cost: { points: 0, beans: 0 },
    usedFreeQuota: false,
    execute: (fn: () => Promise<unknown>) => fn(),
    settle: async () => {},
    fail: async () => '',
    defer: async () => {},
  }),
}))

vi.mock('@/lib/agent-preferences', () => ({
  getAgentPreferences: async () => ({
    imageModelId: 'm1', videoModelId: null, audioModelId: null,
    imageRatio: '3:4', imageTier: '2K', imageQuality: null,
  }),
}))

vi.mock('@/lib/upstream-image', () => ({
  publicizeReferenceImages: async (v: string[] | undefined) => v || [],
}))

import { runAgentToolLoop, MAX_TURNS } from '@/lib/agent-tool-loop'

const brain = {
  id: 'b1', name: 'Brain', modelName: 'brain-x', type: 'TEXT',
  supportsVision: false,
  provider: { baseUrl: 'https://x', apiKey: 'k', adapterId: null, configJson: null },
}

const emitNoop = () => {}

beforeEach(() => { chatResponses.length = 0; chatIndex = 0; capturedPayloads.length = 0 })

describe('runAgentToolLoop —— 执行期回归（TDZ 事故锁死）', () => {
  it('主体能跑通：偏好串人话化读到 modelRows 不抛 TDZ', async () => {
    chatResponses.push({ content: '好的', finishReason: 'stop', promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('不应被调用') },
      defaultTier: '2K',
    })
    expect(out.reply).toBe('好的')
    expect(out.finished).toBe(true)
    expect(out.totalCost).toBe(0)
  })

  it('generate_image → 结果回填 → finish：多轮动作计数正确', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"一只猫","title":"主图","count":2,"ratio":"3:4"}' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"done"}' }] },
    )
    let calls = 0
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async (d) => {
        calls++
        expect(d.model).toBe('m1')
        expect(d.count).toBe(2)
        expect(d.ratio).toBe('3:4@2K')  // 模型给了 ratio，档位缺省 → 用 defaultTier 2K 拼出尺寸
        return { result: { imageUrl: 'https://x/a.png' }, cost: 3, beans: 1 }
      },
      defaultTier: '2K',
    })
    expect(calls).toBe(1)
    expect(out.subtasks).toHaveLength(1)
    expect(out.subtasks[0]).toMatchObject({ type: 'image', status: 'success' })
    expect(out.totalCost).toBe(3)
    expect(out.totalBeans).toBe(1)
    expect(out.reply).toBe('done')
  })

  it('ask_user 收尾：不再继续循环', async () => {
    chatResponses.push({
      content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
      toolCalls: [{ id: 'c1', name: 'ask_user', arguments: '{"questions":[{"question":"要几张？"}]}' }],
    })
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('不应被调用') },
    })
    expect(out.finished).toBe(true)
    expect(out.askQuestions![0].question).toBe('要几张？')
  })

  it('轮次耗尽：强制收尾但不崩', async () => {
    // 每轮都返回同一个 generate_image（永不 finish）
    chatResponses.push({
      content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
      toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"猫"}' }],
    })
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => ({ result: { imageUrl: 'https://x/a.png' }, cost: 1, beans: 0 }),
    })
    expect(out.turns).toBe(MAX_TURNS)
    expect(out.subtasks).toHaveLength(MAX_TURNS)
    expect(out.finished).toBe(false)
  })

  it('工具参数畸形：generate_image 缺 prompt → 不派发，回填提示后继续', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '坏JSON' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"ok"}' }] },
    )
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('不应被调用') },
    })
    expect(out.subtasks).toHaveLength(0)
    expect(out.reply).toBe('ok')
  })

  it('模型全部只吐推理、零正文零动作 → 抛错，不伪装成功', async () => {
    chatResponses.push({ content: '', finishReason: 'length', promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    await expect(runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('不应被调用') },
    })).rejects.toThrow()
  })

  it('已完成的动作写入 checkpoint；恢复时从下一轮继续，不重放已成功动作', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"一只猫","title":"主图"}' }] },
      new Error('planner transient down'),
    )
    let calls = 0
    let saved: import('@/lib/agent-checkpoint').AgentCheckpoint | null = null
    await expect(runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => {
        calls++
        return { result: { imageUrl: 'https://x/a.png' }, cost: 1, beans: 0 }
      },
      onCheckpoint: (cp) => { saved = cp },
    })).rejects.toThrow('planner transient down')

    const snapshot = saved as import('@/lib/agent-checkpoint').AgentCheckpoint | null
    expect(calls).toBe(1)
    expect(snapshot).not.toBeNull()
    if (!snapshot) throw new Error('缺少 checkpoint')
    expect(snapshot.turn).toBe(1)
    expect(snapshot.subtasks).toHaveLength(1)
    expect(snapshot.assetAliases['素材1']).toBe('https://x/a.png')

    chatResponses.length = 0
    chatIndex = 0
    chatResponses.push({
      content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
      toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"resumed done"}' }],
    })
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      checkpoint: snapshot,
      runDeliverable: async () => {
        calls++
        throw new Error('恢复时不应重放已成功动作')
      },
    })

    expect(calls).toBe(1)
    expect(out.reply).toBe('resumed done')
    expect(out.turns).toBe(2)
    expect(out.subtasks).toHaveLength(1)
    expect(out.checkpoint?.finished).toBe(true)
  })
})

describe('confirm 模式闸门 —— 动钱的那一步必须真的被拦住', () => {
  it('confirm：generate_image 不执行，只入队（runDeliverable 一次都不能被调用）', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"一只猫","title":"主图","count":3,"ratio":"1:1","quality":"2K"}' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"等你确认"}' }] },
    )
    let calls = 0
    const pendingActions: import('@/lib/agent-pending').PendingAction[] = []
    const emitted: Record<string, unknown>[] = []
    const out = await runAgentToolLoop({
      emit: (e) => emitted.push(e), userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { calls++; throw new Error('confirm 模式下不应真的执行') },
      executeMode: 'confirm',
      pendingActions,
    })
    // 核心断言：一次都没执行 = 一分钱都没花
    expect(calls).toBe(0)
    expect(pendingActions).toHaveLength(1)
    expect(pendingActions[0]).toMatchObject({ kind: 'image', title: '主图', count: 3, prompt: '一只猫' })
    // 事件也要发出去，前端才能渲染确认卡
    expect(emitted.some((e) => e.type === 'pendingAction')).toBe(true)
    // 队列里的项不能算成功产物（它还没生成）
    expect(out.subtasks.every((s) => s.status !== 'success')).toBe(true)
  })

  it('auto（缺省）：行为完全不变，照常执行', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"一只猫","title":"主图"}' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"done"}' }] },
    )
    let calls = 0
    const out = await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { calls++; return { result: { imageUrl: 'https://x/a.png' }, cost: 1, beans: 0 } },
    })
    expect(calls).toBe(1)
    expect(out.subtasks[0]).toMatchObject({ status: 'success' })
    expect(out.pendingActions).toBeUndefined()
  })

  it('confirm + 生视频：同样只入队不执行', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_video', arguments: '{"prompt":"镜头推进","title":"片头","seconds":5}' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"ok"}' }] },
    )
    let calls = 0
    const pendingActions: import('@/lib/agent-pending').PendingAction[] = []
    await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '拍片',
      candidates: [brain as never],
      runDeliverable: async () => { calls++; throw new Error('不应执行') },
      executeMode: 'confirm',
      pendingActions,
    })
    expect(calls).toBe(0)
    expect(pendingActions).toHaveLength(1)
    expect(pendingActions[0].kind).toBe('video')
  })
})

describe('修订：用户的修改意见必须真的传到模型', () => {
  it('revision 上下文注入首轮 payload（含原方案 + 用户意见）', async () => {
    chatResponses.push(
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c1', name: 'generate_image', arguments: '{"prompt":"暖色调版本","title":"主图"}' }] },
      { content: '', finishReason: 'tool_calls', promptTokens: 0, completionTokens: 0, totalTokens: 0,
        toolCalls: [{ id: 'c2', name: 'finish', arguments: '{"summary":"改好了"}' }] },
    )
    const pending: import('@/lib/agent-pending').PendingAction[] = []
    await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '做电商主图',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('confirm 模式不应执行') },
      executeMode: 'confirm',
      pendingActions: pending,
      revision: {
        note: '换成暖色调，只要 1 张',
        round: 1,
        previous: [{ id: 'p0', kind: 'image', title: '主图', prompt: '冷色调', count: 3 }],
      },
    })
    expect(capturedPayloads.length).toBeGreaterThan(0)
    const payload = capturedPayloads[0]
    // 用户意见
    expect(payload).toContain('换成暖色调')
    // 上一版方案（模型要知道"原来是什么"，才能只改该改的）
    expect(payload).toContain('冷色调')
    expect(payload).toContain('"round":1')
    // 指令要告诉它"保住没被要求改的部分"
    expect(payload).toContain('保留')
  })

  it('没有 revision 时不注入该字段（auto/首轮行为不变）', async () => {
    chatResponses.push({ content: '好的', finishReason: 'stop', promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    await runAgentToolLoop({
      emit: emitNoop, userId: 'u1', taskId: 't1', prompt: '画猫',
      candidates: [brain as never],
      runDeliverable: async () => { throw new Error('不应调用') },
    })
    expect(capturedPayloads[0]).not.toContain('"revision"')
  })
})
