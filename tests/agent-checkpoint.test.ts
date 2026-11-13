import { describe, expect, it } from 'vitest'
import {
  AGENT_CHECKPOINT_TTL_MS,
  AGENT_CHECKPOINT_VERSION,
  isAgentCheckpointExpired,
  parseAgentCheckpoint,
  type AgentCheckpoint,
} from '@/lib/agent-checkpoint'

function checkpoint(over: Partial<AgentCheckpoint> = {}): AgentCheckpoint {
  const now = new Date().toISOString()
  return {
    version: AGENT_CHECKPOINT_VERSION,
    taskId: 't1',
    userId: 'u1',
    createdAt: now,
    updatedAt: now,
    turn: 2,
    actionCount: 3,
    messages: [{ role: 'user', content: '{}' }],
    deliverableIndex: 2,
    subtasks: [{ id: 'task-1', status: 'success' }],
    totalCost: 3,
    totalBeans: 5,
    lastText: '继续',
    decisions: [{ label: '模型', value: 'm1', reason: '偏好' }],
    assetAliases: { 素材1: 'https://cdn.example/1.png' },
    nextGeneratedAssetIndex: 2,
    agentTrace: [{ turn: 1, action: 'generate_image', status: 'success', durationMs: 100 }],
    finished: false,
    ...over,
  }
}

describe('Agent checkpoint', () => {
  it('只接受同一任务、同一用户的当前版本检查点', () => {
    expect(parseAgentCheckpoint(checkpoint(), { taskId: 't1', userId: 'u1' })?.turn).toBe(2)
    expect(parseAgentCheckpoint(checkpoint(), { taskId: 't2', userId: 'u1' })).toBeNull()
    expect(parseAgentCheckpoint(checkpoint(), { taskId: 't1', userId: 'u2' })).toBeNull()
    expect(parseAgentCheckpoint(checkpoint({ version: 999 as never }), { taskId: 't1', userId: 'u1' })).toBeNull()
  })

  it('恢复前会清洗素材编号和非法数值，不把脏 payload 带进执行链', () => {
    const parsed = parseAgentCheckpoint({
      ...checkpoint(),
      actionCount: -10,
      totalCost: Number.NaN,
      assetAliases: {
        素材1: 'https://cdn.example/1.png',
        图片1: '/api/asset/not-generated.png',
        素材2: '',
      },
    }, { taskId: 't1', userId: 'u1' })
    expect(parsed?.actionCount).toBe(0)
    expect(parsed?.totalCost).toBe(0)
    expect(parsed?.assetAliases).toEqual({ 素材1: 'https://cdn.example/1.png' })
  })

  it('超过 TTL 的检查点不再恢复', () => {
    const old = checkpoint({
      updatedAt: new Date(Date.now() - AGENT_CHECKPOINT_TTL_MS - 1000).toISOString(),
    })
    expect(isAgentCheckpointExpired(old)).toBe(true)
  })
})
