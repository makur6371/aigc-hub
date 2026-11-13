import { describe, it, expect } from 'vitest'
import { executeAdapterCode } from '@/lib/adapter-runtime'
import { OPENAI_COMPATIBLE_ADAPTER_SOURCE } from '@/lib/adapters/openai-compatible'

/**
 * reasoning_effort 必须真的落到请求体里（防回归）
 *
 * 这是「思考模型推理吃满输出预算」修复的落点：
 * 如果 adapter 的 fieldMap 漏了这条别名，参数会被静默丢掉，
 * 表现就是修复看起来做了、实际推理量一点没降。
 */
function buildWith(params: Record<string, unknown>) {
  const adapter = executeAdapterCode(OPENAI_COMPATIBLE_ADAPTER_SOURCE)
  return adapter.buildChatRequest(
    { baseUrl: 'https://x/v1', apiKey: 'k', modelName: 'glm-5.3-flash' },
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8192, ...params },
  ).body as Record<string, unknown>
}

describe('reasoning_effort 落到请求体', () => {
  it("reasoningEffort: 'low' → body.reasoning_effort = 'low'", () => {
    const body = buildWith({ reasoningEffort: 'low' })
    expect(body.reasoning_effort).toBe('low')
  })

  it('不传时不出现该字段（非思考模型不受影响）', () => {
    const body = buildWith({})
    expect('reasoning_effort' in body).toBe(false)
  })

  it('maxTokens 仍然映射为 max_tokens（没有互相干扰）', () => {
    const body = buildWith({ reasoningEffort: 'none' })
    expect(body.max_tokens).toBe(8192)
    expect(body.reasoning_effort).toBe('none')
  })

  it("'medium' / 'high' 等取值原样透传（不写死 low）", () => {
    for (const v of ['none', 'medium', 'high'] as const) {
      expect(buildWith({ reasoningEffort: v }).reasoning_effort).toBe(v)
    }
  })
})
