import { describe, it, expect } from 'vitest'
import { isLegacyPlanTurnNoAction, looksLikeLegacyPlanText } from '@/lib/agent-tool-loop'

/**
 * 回落判定 —— 决定「模型不支持工具调用时是否回到旧单次规划路径」。
 * 误判代价很高：真支援工具的模型被误判 → 徒增一次旧规划（多扣一次钱）；漏判 → 用户看到一堆 JSON。
 * 这里锁死边界。
 */
describe('isLegacyPlanTurnNoAction', () => {
  it('首轮 + 零进展 + 旧式计划文本 → true（应回落）', () => {
    expect(isLegacyPlanTurnNoAction(0, 0, '{"intent":"generation","deliverables":[]}')).toBe(true)
  })

  it('非首轮 → false（已经跑过动作，不该再回落重跑）', () => {
    expect(isLegacyPlanTurnNoAction(1, 0, '{"intent":"generation"}')).toBe(false)
  })

  it('已有产出 → false（不能丢掉已生成的成果）', () => {
    expect(isLegacyPlanTurnNoAction(0, 2, '{"intent":"generation"}')).toBe(false)
  })

  it('普通闲聊文本 → false（正常结束，不该回落）', () => {
    expect(isLegacyPlanTurnNoAction(0, 0, '好的，你想画什么风格？')).toBe(false)
  })
})

describe('looksLikeLegacyPlanText', () => {
  it('只认计划协议独有字段，避免把含 JSON 的普通回复误判', () => {
    expect(looksLikeLegacyPlanText('{"deliverables":[{"title":"x"}]}')).toBe(true)
    expect(looksLikeLegacyPlanText('{"code":200,"msg":"ok"}')).toBe(false)
  })
})
