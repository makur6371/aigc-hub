import { describe, it, expect } from 'vitest'
import { attachVisionImages } from '@/lib/llm-provider'

/**
 * 多模态挂图 —— 回归第 2 期发现的缺口：
 * 工具循环全程带 assistant.tool_calls / role:'tool' 消息，streamChatToUpstream 会走
 * 「原样透传」分支、绕过 buildMessages，于是 images 参数失效，规划模型只能看到
 * JSON 里的 URL 文本而看不到图（与旧单次规划路径行为不一致）。
 * 这里锁死：带工具语义的消息也要把图挂到最后一条 user 消息上。
 */
describe('attachVisionImages —— 带工具消息路径也要挂参考图', () => {
  const imgs = ['https://x/a.png', 'https://x/b.png']

  it('挂到最后一条 user 消息，且不破坏前面的 tool_calls / tool 消息', () => {
    const msgs = [
      { role: 'user', content: '{"requirement":"画猫"}' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'list_models' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'list_models', content: '[]' },
      { role: 'assistant', content: '继续' },
    ]
    const out = attachVisionImages(msgs as never, imgs)
    // 首条 user 被挂图（历史最后一条 user 即首条，因为后续都是 assistant/tool）
    expect(Array.isArray(out[0].content)).toBe(true)
    const parts = out[0].content as { type: string; image_url?: { url: string } }[]
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url)).toEqual(imgs)
    expect(parts[0]).toMatchObject({ type: 'text', text: '{"requirement":"画猫"}' })
    // 工具消息原样保留
    expect(out[1]).toMatchObject({ role: 'assistant' })
    expect((out[1] as { tool_calls?: unknown }).tool_calls).toBeTruthy()
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })

  it('多条 user 时只挂最后一条（与 buildMessages 口径一致）', () => {
    const out = attachVisionImages([
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二轮' },
    ] as never, imgs)
    expect(typeof out[0].content).toBe('string')
    expect(Array.isArray(out[2].content)).toBe(true)
  })

  it('没有 user 消息时原样返回，不崩', () => {
    const out = attachVisionImages([{ role: 'assistant', content: 'hi' }] as never, imgs)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('hi')
  })
})
