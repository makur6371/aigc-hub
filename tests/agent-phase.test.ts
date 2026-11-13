import { describe, it, expect } from 'vitest'
import { makePhaseReporter, type AgentRunCtx } from '@/lib/agent-executor'

/**
 * Agent 相位上报 —— 回归「Agent 出的图在成果区永远显示『准备中』」。
 *
 * 工具面板/画布都有 nodePhase（闸门 queued → 发出 running），
 * Agent 此前完全不发，前端拿不到相位，占位只能停在「准备中」直接跳到完成。
 */
const mkCtx = () => {
  const events: Record<string, unknown>[] = []
  const ctx = { emit: (o: Record<string, unknown>) => { events.push(o) } } as unknown as AgentRunCtx
  return { ctx, events }
}

describe('makePhaseReporter', () => {
  it('queued → running 都上报，并带上 deliverableId/index/count', () => {
    const { ctx, events } = mkCtx()
    const report = makePhaseReporter(ctx, { deliverableId: 'task-2', index: 1, count: 3 })
    report('queued')
    report('running')

    expect(events.map((e) => e.type)).toEqual(['nodePhase', 'nodePhase'])
    expect(events[0]).toMatchObject({ phase: 'queued', deliverableId: 'task-2', index: 1, count: 3 })
    expect(events[1]).toMatchObject({ phase: 'running', deliverableId: 'task-2', index: 1, count: 3 })
    expect(typeof events[0].at).toBe('number')
  })

  it('单调不回退：已 running 后不再发 queued（429/5xx 重试会重新进闸门）', () => {
    const { ctx, events } = mkCtx()
    const report = makePhaseReporter(ctx, { deliverableId: 't', index: 0, count: 1 })
    report('queued')
    report('running')
    report('queued')   // 重试回闸门 —— 必须被忽略，否则前端计时重置、像卡住
    report('running')  // 重复 running 也忽略

    expect(events.map((e) => e.phase)).toEqual(['queued', 'running'])
  })

  it('同一份重复 queued 会照发（首次进入闸门的真实时刻）', () => {
    const { ctx, events } = mkCtx()
    const report = makePhaseReporter(ctx, { deliverableId: 't', index: 0, count: 1 })
    report('queued')
    report('queued')
    expect(events).toHaveLength(2)
  })

  it('deliverableId 缺省时回落到 ctx.deliverableId', () => {
    const { ctx, events } = mkCtx()
    ;(ctx as { deliverableId?: string }).deliverableId = 'from-ctx'
    const report = makePhaseReporter(ctx, { index: 0, count: 1 })
    report('queued')
    expect(events[0]).toMatchObject({ deliverableId: 'from-ctx' })
  })

  it('每份独立计时：不同 index 各自维护 reachedRunning', () => {
    const { ctx, events } = mkCtx()
    const r0 = makePhaseReporter(ctx, { deliverableId: 'd', index: 0, count: 2 })
    const r1 = makePhaseReporter(ctx, { deliverableId: 'd', index: 1, count: 2 })
    r0('running')
    r1('queued')  // 第 1 份还在排队，不该被第 0 份的 running 影响
    expect(events.map((e) => [e.index, e.phase])).toEqual([[0, 'running'], [1, 'queued']])
  })
})
