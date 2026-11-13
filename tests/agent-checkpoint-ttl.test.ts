import { describe, expect, it } from 'vitest'
import {
  AGENT_CHECKPOINT_TTL_MS,
  AGENT_CHECKPOINT_VERSION,
  isAgentCheckpointExpired,
  type AgentCheckpoint,
} from '@/lib/agent-checkpoint'

/**
 * Q-D16 残留：检查点有效期不能只信检查点自己写的时间戳。
 */
function cp(overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint {
  const now = new Date().toISOString()
  return {
    version: AGENT_CHECKPOINT_VERSION,
    taskId: 't1',
    userId: 'u1',
    createdAt: now,
    updatedAt: now,
    turn: 3,
    actionCount: 5,
    messages: [],
    deliverableIndex: 1,
    subtasks: [],
    totalCost: 10,
    totalBeans: 0,
    lastText: '',
    decisions: [],
    assetAliases: {},
    nextGeneratedAssetIndex: 1,
    agentTrace: [],
    finished: false,
    ...overrides,
  }
}

const DAY = 24 * 60 * 60 * 1000

describe('isAgentCheckpointExpired', () => {
  it('TTL 内未过期、超 TTL 过期（基线行为不变）', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    expect(isAgentCheckpointExpired(cp({ updatedAt: new Date(now - DAY).toISOString() }), now)).toBe(false)
    const stale = new Date(now - (AGENT_CHECKPOINT_TTL_MS + DAY)).toISOString()
    expect(isAgentCheckpointExpired(cp({ updatedAt: stale }), now)).toBe(true)
  })

  it('时间戳在未来（超过 5 分钟偏移）→ 直接判失效', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    const future = new Date(now + 30 * DAY).toISOString()
    expect(isAgentCheckpointExpired(cp({ updatedAt: future }), now)).toBe(true)
  })

  it('两条防线各自生效：未来时间戳直接拒；库内时间可压回被改新的时间戳', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    // 防线 1：时间戳在未来（超偏移）一律失效，不需要库内时间就能挡住
    expect(isAgentCheckpointExpired(cp({ updatedAt: new Date(now + 10 * DAY).toISOString() }), now)).toBe(true)
    // 防线 2：payload 里的时间被改到「刚刚」（TTL 内），但任务行其实是 30 天前更新的
    //        —— 取较早的库内时间，照样过期。这是没有未来时间戳时的绕过路径。
    const justNow = new Date(now - 60 * 1000).toISOString()
    expect(isAgentCheckpointExpired(cp({ updatedAt: justNow }), now, null)).toBe(false)
    expect(isAgentCheckpointExpired(cp({ updatedAt: justNow }), now, new Date(now - 30 * DAY))).toBe(true)
  })

  it('新鲜检查点 + 新鲜库时间 → 正常可恢复（不能把好事也拦了）', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    const fresh = new Date(now - 2 * 60 * 60 * 1000).toISOString()
    expect(isAgentCheckpointExpired(cp({ updatedAt: fresh }), now, new Date(now - 60 * 60 * 1000))).toBe(false)
  })

  it('坏时间戳（非数字/空串）视为过期，不抛错', () => {
    expect(isAgentCheckpointExpired(cp({ updatedAt: 'not-a-date' }), Date.now())).toBe(true)
    expect(isAgentCheckpointExpired(cp({ updatedAt: '' }), Date.now())).toBe(true)
  })
})
