import { describe, it, expect, beforeEach } from 'vitest'
import { useToolRunStore } from '@/stores/useToolRunStore'

/**
 * 成果区排队位协议（2026-10-18）
 *
 * 起因：电商 Agent 之前**没有**用这套机制 —— 自己在操作面板里画了 4 个进度格，
 * 跑完才把结果一次性塞进成果区。用户反馈「为什么在这里等，而不是在成果排队区」。
 *
 * 顺手把协议抽成 store 动作（enqueueSlots / consumeSlot / failSlot / flushStaleSlots），
 * 因为它有四个必须对齐的细节，写错任何一条都会出现「占位永远转圈」或「结果串位」。
 */

const slot = (queueId: string, i: number) => ({ queueId, queueIndex: i, status: 'running' as const, url: '' })
const results = () => useToolRunStore.getState().results
const reset = () => useToolRunStore.setState({ results: [], jobs: [], focusedJobId: null })

describe('enqueueSlots：派发即在成果区占位', () => {
  beforeEach(reset)

  it('按 count 建 N 个占位，置顶，带标注', () => {
    useToolRunStore.getState().enqueueSlots({
      queueId: 'q1', count: 3, nodeId: 'n1', toolName: '电商Agent模式',
      noteFor: (i) => ['主图', '细节特写', '场景搭配'][i],
    })
    const r = results()
    expect(r).toHaveLength(3)
    expect(r.map((x) => x.queueNote)).toEqual(['主图', '细节特写', '场景搭配'])
    expect(r.every((x) => x.status === 'running' && x.toolName === '电商Agent模式')).toBe(true)
  })

  it('重复派发同 queueId 不留僵尸占位', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 4, nodeId: 'n1' })
    useToolRunStore.getState().enqueueSlots({ queueId: 'q1', count: 2, nodeId: 'n1' })
    expect(results().filter((x) => x.queueId === 'q1')).toHaveLength(2)
  })

  it('不动别的批次的占位', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 2, nodeId: 'n1' })
    useToolRunStore.getState().enqueueSlots({ queueId: 'q2', count: 2, nodeId: 'n2' })
    expect(results()).toHaveLength(4)
  })
})

describe('consumeSlot：按 queueIndex 精确落位（不串位）', () => {
  beforeEach(reset)

  it('第 2 张回来落到第 2 个占位，不是第一个', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 3, nodeId: 'n1' })
    useToolRunStore.getState().consumeSlot({
      queueId: 'q1', queueIndex: 1,
      result: { url: 'u2', kind: 'image', nodeId: 'n1', status: 'done' },
    })
    const r = results()
    expect(r.find((x) => x.url === 'u2')?.queueIndex).toBeUndefined()
    // 第 1、3 个占位仍在排队
    expect(r.filter((x) => x.status === 'running')).toHaveLength(2)
  })

  it('全部消费完后结果一条不少', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 3, nodeId: 'n1' })
    for (let i = 0; i < 3; i++) {
      useToolRunStore.getState().consumeSlot({
        queueId: 'q1', queueIndex: i,
        result: { url: `u${i}`, kind: 'image', nodeId: 'n1', status: 'done' },
      })
    }
    const r = results()
    expect(r).toHaveLength(3)
    expect(r.map((x) => x.url).sort()).toEqual(['u0', 'u1', 'u2'])
    expect(r.every((x) => x.status === 'done')).toBe(true)
  })

  it('占位已用完再来结果 → 插到最前，不丢（重试追加场景）', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 1, nodeId: 'n1' })
    useToolRunStore.getState().consumeSlot({
      queueId: 'q1', queueIndex: 0,
      result: { url: 'a', kind: 'image', nodeId: 'n1', status: 'done' },
    })
    useToolRunStore.getState().consumeSlot({
      queueId: 'q1',
      result: { url: 'b', kind: 'image', nodeId: 'n1', status: 'done' },
    })
    expect(results().map((x) => x.url).sort()).toEqual(['a', 'b'])
  })
})

describe('failSlot / flushStaleSlots：绝不留永久转圈的占位', () => {
  beforeEach(reset)

  it('单张失败只终结那一张，原因写进卡片', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 3, nodeId: 'n1' })
    useToolRunStore.getState().failSlot({ queueId: 'q1', queueIndex: 0, failReason: '上游审核不通过' })
    const r = results()
    expect(r.filter((x) => x.status === 'error')).toHaveLength(1)
    expect(r.find((x) => x.failReason === '上游审核不通过')).toBeDefined()
    expect(r.filter((x) => x.status === 'running')).toHaveLength(2)
  })

  it('流结束时收尾剩余占位（默认兜底文案）', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 3, nodeId: 'n1' })
    useToolRunStore.getState().flushStaleSlots('q1')
    const r = results()
    expect(r.some((x) => x.status === 'running')).toBe(false)
    expect(r.filter((x) => x.failReason)).toHaveLength(3)
  })

  it('已完成的占位不被收尾改动', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 2, nodeId: 'n1' })
    useToolRunStore.getState().consumeSlot({
      queueId: 'q1', queueIndex: 0,
      result: { url: 'a', kind: 'image', nodeId: 'n1', status: 'done' },
    })
    useToolRunStore.getState().flushStaleSlots('q1')
    expect(results().find((x) => x.url === 'a')?.status).toBe('done')
  })

  it('收尾只影响本批次', () => {
    const s = useToolRunStore.getState()
    s.enqueueSlots({ queueId: 'q1', count: 2, nodeId: 'n1' })
    s.enqueueSlots({ queueId: 'q2', count: 2, nodeId: 'n2' })
    useToolRunStore.getState().flushStaleSlots('q1')
    expect(results().filter((x) => x.queueId === 'q2' && x.status === 'running')).toHaveLength(2)
  })
})
