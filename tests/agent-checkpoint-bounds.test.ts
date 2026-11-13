import { describe, expect, it } from 'vitest'
import {
  AGENT_CHECKPOINT_VERSION,
  CHECKPOINT_MAX_CONTENT_CHARS,
  CHECKPOINT_MAX_MESSAGES,
  CHECKPOINT_MAX_TRACE_ENTRIES,
  parseAgentCheckpoint,
  sanitizeCheckpoint,
  type AgentCheckpoint,
} from '@/lib/agent-checkpoint'

/**
 * Q-D16：checkpoint 写在 GenerationTask.payload 里，必须有界。
 * 旧实现只在读取时靠 normalize 过滤类型，条数与单条长度都不封顶，
 * 8 轮 × 每轮全量工具结果会让 payload 持续膨胀（且每次读任务都要整个拉出来）。
 */

function baseCheckpoint(messages: AgentCheckpoint['messages'], traceSize: number): AgentCheckpoint {
  const now = new Date().toISOString()
  return {
    version: AGENT_CHECKPOINT_VERSION,
    taskId: 't1',
    userId: 'u1',
    createdAt: now,
    updatedAt: now,
    turn: 8,
    actionCount: 24,
    messages,
    deliverableIndex: 5,
    subtasks: [],
    totalCost: 100,
    totalBeans: 3,
    lastText: 'x'.repeat(50_000),
    decisions: [],
    assetAliases: {},
    nextGeneratedAssetIndex: 1,
    agentTrace: Array.from({ length: traceSize }, (_, i) => ({
      turn: (i % 8) + 1,
      action: 'generate_image',
      status: 'success' as const,
      durationMs: 10,
    })),
    finished: false,
  }
}

describe('sanitizeCheckpoint 写入侧封顶', () => {
  it('消息只留尾部若干条，且不从孤立 tool 结果开始', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      role: i % 3 === 2 ? 'tool' : i % 3 === 1 ? 'assistant' : 'user',
      content: `m${i}`,
      ...(i % 3 === 2 ? { tool_call_id: `c${i}`, name: 'generate_image' } : {}),
    }))
    const out = sanitizeCheckpoint(baseCheckpoint(msgs, 3))
    expect(out.messages.length).toBeLessThanOrEqual(CHECKPOINT_MAX_MESSAGES)
    expect(out.messages[0].role).not.toBe('tool')
    // 保留的必须是尾部（最后一条内容还在）
    expect(out.messages[out.messages.length - 1].content).toBe('m199')
  })

  it('单条正文与 lastText 截到上限内', () => {
    const big = 'y'.repeat(50_000)
    const out = sanitizeCheckpoint(baseCheckpoint([{ role: 'user', content: big }], 1))
    expect(out.messages[0].content.length).toBeLessThanOrEqual(CHECKPOINT_MAX_CONTENT_CHARS)
    expect(out.lastText.length).toBeLessThanOrEqual(CHECKPOINT_MAX_CONTENT_CHARS)
    expect(out.messages[0].content).toMatch(/\[已截断\]$/)
  })

  it('trace 只留最近若干条（保留尾部，最新一轮不丢）', () => {
    const out = sanitizeCheckpoint(baseCheckpoint([], CHECKPOINT_MAX_TRACE_ENTRIES + 380))
    expect(out.agentTrace.length).toBe(CHECKPOINT_MAX_TRACE_ENTRIES)
  })

  it('封顶后的 checkpoint 能原样 parse 回来（写读两侧一致，不会自毁）', () => {
    const msgs = Array.from({ length: 90 }, (_, i) => ({
      role: i % 4 === 3 ? 'tool' : 'user',
      content: 'z'.repeat(9000),
      ...(i % 4 === 3 ? { tool_call_id: `c${i}` } : {}),
    }))
    const cp = sanitizeCheckpoint(baseCheckpoint(msgs, 300))
    const parsed = parseAgentCheckpoint(JSON.parse(JSON.stringify(cp)), { taskId: 't1', userId: 'u1' })
    expect(parsed).not.toBeNull()
    expect(parsed!.messages.length).toBeLessThanOrEqual(CHECKPOINT_MAX_MESSAGES)
    expect(parsed!.agentTrace.length).toBeLessThanOrEqual(CHECKPOINT_MAX_TRACE_ENTRIES)
    expect(parsed!.turn).toBe(8)
    expect(parsed!.actionCount).toBe(24)
  })
})
