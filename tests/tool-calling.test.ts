import { describe, it, expect } from 'vitest'
import { parseOpenAIStyleStreamChunk, parseChatResponseFromSpec, parseToolCalls } from '@/lib/adapters/normalize/chat'

/**
 * 工具调用（function calling）管线 —— 第 1 期「打通链路」
 *
 * 背景：Agent 现在是单次规划（一次吐一个大 JSON），实测暴露了 4 类静默失败
 * （空响应 / 截断 / 假计划 / 模型引用写错）。改造方向是「小步动作 + 有界循环」，
 * 前提是传输层能把 tools 下发、把 tool_calls 增量收回来。
 * 这组测试锁死这两条链路，防止后续被改坏（改坏的表现是 Agent 静默退回纯文本）。
 */

describe('tool_calls —— 非流式解析', () => {
  it('标准 OpenAI 形态：arguments 是 JSON 字符串，原样透出', () => {
    const calls = parseToolCalls([
      { id: 'call_1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"a cat","count":2}' } },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('generate_image')
    expect(JSON.parse(calls[0].arguments)).toEqual({ prompt: 'a cat', count: 2 })
  })

  it('缺 id / 缺 name / 非数组 → 安全降级，不抛错', () => {
    expect(parseToolCalls(undefined)).toEqual([])
    expect(parseToolCalls('nope')).toEqual([])
    expect(parseToolCalls([{ function: { name: '' } }])).toEqual([])
    const noId = parseToolCalls([{ function: { name: 'ask_user', arguments: '{}' } }])
    expect(noId[0].id).toBe('call_0')
  })

  it('arguments 不是字符串（部分厂商直接给对象）→ 序列化保留', () => {
    const calls = parseToolCalls([{ id: 'c', function: { name: 'finish', arguments: { ok: true } } }])
    expect(JSON.parse(calls[0].arguments)).toEqual({ ok: true })
  })
})

describe('tool_calls —— 流式分片解析', () => {
  const line = (obj: unknown) => `data: ${JSON.stringify(obj)}`
  const chunkOf = (delta: Record<string, unknown>) =>
    parseOpenAIStyleStreamChunk(line({ choices: [{ index: 0, delta, finish_reason: null }] }))

  it('首片带 id+name，后续片只带 arguments 增量', () => {
    const first = chunkOf({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'generate_image', arguments: '' } }] })
    expect(first?.toolCalls?.[0]).toMatchObject({ index: 0, id: 'call_abc', name: 'generate_image' })

    const more = chunkOf({ tool_calls: [{ index: 0, function: { arguments: '{"prompt"' } }] })
    expect(more?.toolCalls?.[0]).toMatchObject({ index: 0, argumentsDelta: '{"prompt"' })
    // 后续片不含 id/name（OpenAI 只在首片下发）
    expect(more?.toolCalls?.[0].id).toBeUndefined()
    expect(more?.toolCalls?.[0].name).toBeUndefined()
  })

  it('多工具并行分片：index 区分不同调用', () => {
    const c = chunkOf({
      tool_calls: [
        { index: 0, id: 'c0', function: { name: 'generate_image' } },
        { index: 1, id: 'c1', function: { name: 'generate_video' } },
      ],
    })
    expect(c?.toolCalls?.map((t) => t.name)).toEqual(['generate_image', 'generate_video'])
    expect(c?.toolCalls?.map((t) => t.index)).toEqual([0, 1])
  })

  it('纯 tool_call 帧（无 content/reasoning）不能被当成空帧丢掉', () => {
    // 回归：早期实现只认 content/reasoning/finishReason/usage，纯工具帧会被返回 null 直接丢弃
    const c = chunkOf({ tool_calls: [{ index: 0, id: 'x', function: { name: 'ask_user', arguments: '{}' } }] })
    expect(c).not.toBeNull()
    expect(c?.toolCalls).toHaveLength(1)
  })

  it('[DONE] 与空行 → null（不产生幽灵 chunk）', () => {
    expect(parseOpenAIStyleStreamChunk('data: [DONE]')).toBeNull()
    expect(parseOpenAIStyleStreamChunk('')).toBeNull()
  })
})

describe('非流式响应 —— toolCalls 透出', () => {
  it('含 tool_calls 时返回它们，普通回答不受影响', () => {
    const spec = { contentPath: ['choices', 0, 'message', 'content'] } as never
    const withTools = parseChatResponseFromSpec(
      { choices: [{ message: { content: '', tool_calls: [{ id: 'a', function: { name: 'finish', arguments: '{}' } }] } }] },
      spec,
    )
    expect(withTools.toolCalls?.[0].name).toBe('finish')

    const plain = parseChatResponseFromSpec({ choices: [{ message: { content: '你好' } }] }, spec)
    expect(plain.content).toBe('你好')
    expect(plain.toolCalls).toBeUndefined()
  })
})
