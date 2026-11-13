import { describe, it, expect } from 'vitest'
import { resolveAgentReasoningEffort } from '@/lib/agent-plan'

/**
 * Agent 思考强度策略（防回归）
 *
 * 背景（2026-10-01 生产实测，真实 6 方向套图工具调用场景）：
 *   同一个 glm-5.3-flash，思考模型的 reasoning 与正文**共用输出预算**：
 *     默认 effort → 推理 1272 token、耗时 40.3s
 *     effort=low → 推理   19 token、耗时 16.7s，6 个 tool_call 一个不少
 *   而生产失败日志出现过「只输出推理过程（14256 字）≈ 4700 token 未产出动作」，
 *   即推理吃满 max_tokens、动作没机会产出 —— 用户看到的就是「思考很久然后失败」。
 *
 * 所以：思考模型下发 low，非思考模型**不下发**（它们不认识该字段，可能 400）。
 */
describe('Agent 思考强度策略', () => {
  it('metadata.think = true → low（压推理、提速，产出等价）', () => {
    expect(resolveAgentReasoningEffort({ think: true })).toBe('low')
  })

  it('非思考模型 → undefined（不下发，避免不认识该字段的上游 400）', () => {
    expect(resolveAgentReasoningEffort({ think: false })).toBeUndefined()
    expect(resolveAgentReasoningEffort({})).toBeUndefined()
    expect(resolveAgentReasoningEffort(null)).toBeUndefined()
    expect(resolveAgentReasoningEffort(undefined)).toBeUndefined()
  })

  it('metadata 畸形（字符串/数组/怪对象）不抛错，按非思考处理', () => {
    expect(resolveAgentReasoningEffort('think')).toBeUndefined()
    expect(resolveAgentReasoningEffort([1, 2])).toBeUndefined()
    expect(resolveAgentReasoningEffort({ think: 'true' })).toBeUndefined() // 严格 true
  })

  it('显式 override 优先于 metadata（便于按场景调）', () => {
    expect(resolveAgentReasoningEffort({ think: true }, 'none')).toBe('none')
    expect(resolveAgentReasoningEffort({ think: false }, 'high')).toBe('high')
  })
})
