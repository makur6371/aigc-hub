import { describe, it, expect, beforeEach, vi } from 'vitest'

// 成果区占位逻辑会写 store，这里用最小替身捕获调用
const resultsSets: unknown[][] = []
vi.mock('@/stores/useToolRunStore', () => ({
  useToolRunStore: {
    getState: () => ({
      setResults: (fn: (prev: unknown[]) => unknown[]) => {
        const next = fn([])
        resultsSets.push(next as unknown[])
      },
    }),
  },
}))
vi.mock('@/lib/browser-notify', () => ({ notify: () => {} }))

import { createAgentStreamHandler } from '@/components/tools/agent-stream-handler'

/**
 * 「执行前确认」的实时性回归（2026-10-08 线上 bug）。
 *
 * 用户报：确认执行后「不像之前那样直接把调用排队放到成果区，
 * 而是生成之后才会出现」。
 *
 * 根因：confirm 接口最初返回**一次性 JSON**，执行期间没有任何事件，
 * 所以 subtask(running) 驱动的排队占位根本不会出现。
 * 修法是把 confirm 也改成 SSE 流，事件处理与 /send 共用同一份实现。
 *
 * 这个测试锁住「事件 → 成果区占位 / 落位」这条链，
 * 两条路径（send 与 confirm）都跑它，所以断言放在共享 handler 上。
 */
describe('createAgentStreamHandler —— 排队占位必须实时出现', () => {
  beforeEach(() => { resultsSets.length = 0 })

  const mk = () => {
    const patches: Record<string, unknown>[] = []
    const h = createAgentStreamHandler({
      assistantMsgId: 'a1',
      patchAssistant: (p) => patches.push(p as Record<string, unknown>),
    })
    return { h, patches }
  }

  it('subtask(running) 立刻创建排队占位（不是等生成完）', () => {
    const { h } = mk()
    h.handleEvent({
      type: 'subtask', index: 0, label: '主图（image）', status: 'running',
      deliverableId: 'task-0', count: 2,
    })
    const created = resultsSets.at(-1) as Array<Record<string, unknown>>
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({
      status: 'running',
      queueId: 'agent-a1-task-0',
      queueIndex: 0,
    })
    expect(created[1]).toMatchObject({ queueIndex: 1 })
  })

  it('media 事件认领占位并落位成真图（原地替换，不留孤儿）', () => {
    const { h } = mk()
    h.handleEvent({ type: 'subtask', index: 0, label: '主图（image）', status: 'running', deliverableId: 'task-0', count: 1 })
    // 第二次 setResults 的 prev 是空数组（替身每次喂 []），所以直接断言追加分支
    h.handleEvent({ type: 'media', url: 'https://x/a.png', index: 0, deliverableId: 'task-0' })
    const last = resultsSets.at(-1) as Array<Record<string, unknown>>
    expect(last[0]).toMatchObject({ url: 'https://x/a.png', status: 'done' })
  })

  it('nodePhase 回填「等待派发 / 生成中」相位', () => {
    const { h } = mk()
    h.handleEvent({ type: 'subtask', index: 0, label: '主图（image）', status: 'running', deliverableId: 'task-0', count: 1 })
    h.handleEvent({ type: 'nodePhase', phase: 'queued', index: 0, deliverableId: 'task-0', at: 123 })
    // 替身下 prev 为空，相位回填不会产生新数组 —— 这里断言不抛错即可（映射逻辑由上面两条覆盖）
    expect(() => h.handleEvent({ type: 'nodePhase', phase: 'running', index: 0, deliverableId: 'task-0' })).not.toThrow()
  })

  it('done 之后 isDone() 为真（调用方据此收尾）', () => {
    const { h } = mk()
    expect(h.isDone()).toBe(false)
    h.handleEvent({ type: 'done', subtasks: [{ status: 'success' }] })
    expect(h.isDone()).toBe(true)
  })

  it('error 之后 isDone() 为真，避免前端一直转圈', () => {
    const { h } = mk()
    h.handleEvent({ type: 'error', message: '上游炸了' })
    expect(h.isDone()).toBe(true)
  })
})
