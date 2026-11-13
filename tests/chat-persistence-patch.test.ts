import { describe, expect, it, vi } from 'vitest'
import { collectSubtaskMedia, patchAssistantTaskMessage } from '@/lib/chat-persistence'

/**
 * Q-106 残留收口：confirm / revise / resume 三处原本各写一份
 * 「找同任务的助手气泡并回写」，行为细节已经分叉（有的删 pendingActions、
 * 有的带媒体、有的新建时把上一条别的任务的 meta 一起抄进新消息）。
 */

function makePrisma(latest: { id: string; meta: string } | null) {
  const updated: Array<{ id: string; data: Record<string, unknown> }> = []
  const created: Array<Record<string, unknown>> = []
  // patch 走 prisma.chatMessage（find/update），新建走 $transaction 内的 tx（取号 + create）
  const store = { findFirst: vi.fn().mockResolvedValue(latest), update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { updated.push({ id: where.id, data }); return {} }) }
  const tx = {
    chatMessage: {
      findFirst: store.findFirst,
      update: store.update,
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: 4 } }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 'new' } }),
    },
    chatSession: { update: vi.fn() },
  }
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }
  const withDirect = Object.assign(prisma, { chatMessage: tx.chatMessage })
  return { prisma: withDirect as never, updated, created }
}

describe('collectSubtaskMedia', () => {
  it('只收成功子任务；出现视频则整体归类为 video', () => {
    const m = collectSubtaskMedia([
      { status: 'success', imageUrls: ['a.png', 'b.png'] },
      { status: 'failed', imageUrls: ['nope.png'] },
      { status: 'success', imageUrl: 'c.png' },
      { status: 'success', videoUrl: 'v.mp4' },
    ])
    expect(m.urls).toEqual(['a.png', 'b.png', 'c.png', 'v.mp4'])
    expect(m.type).toBe('video')
  })

  it('纯图片按 image 归类', () => {
    const m = collectSubtaskMedia([{ status: 'success', imageUrl: 'x.png' }])
    expect(m).toEqual({ urls: ['x.png'], type: 'image' })
  })
})

describe('patchAssistantTaskMessage', () => {
  it('命中同任务气泡：浅合并 meta，并可删键（confirm 清 pendingActions）', async () => {
    const prev = { taskId: 't1', decisions: [{ label: 'a', value: 'b', reason: '' }], pendingActions: [{ id: 'p1' }] }
    const { prisma, updated } = makePrisma({ id: 'm1', meta: JSON.stringify(prev) })
    const hit = await patchAssistantTaskMessage(prisma, 's1', 't1', {
      metaOmit: ['pendingActions'],
      metaMerge: { subtasks: [], confirmed: true },
    })
    expect(hit).toBe(true)
    const meta = JSON.parse(updated[0].data.meta as string)
    expect(meta.confirmed).toBe(true)
    expect(meta.decisions).toEqual(prev.decisions) // 原有键保留
    expect('pendingActions' in meta).toBe(false)
  })

  it('会话里最后一条属于别的任务时不许改（防串台）', async () => {
    const { prisma, updated, created } = makePrisma({ id: 'm9', meta: JSON.stringify({ taskId: 'other' }) })
    const hit = await patchAssistantTaskMessage(prisma, 's1', 't1', { metaMerge: { subtasks: [] } })
    expect(hit).toBe(false)
    expect(updated).toHaveLength(0)
    expect(created).toHaveLength(0) // 没给 createIfMissing 就不该凭空造消息
  })

  it('未命中且给了 createIfMissing：新建消息的 meta 不继承别的气泡（修 resume 旧行为）', async () => {
    const { prisma, created } = makePrisma({ id: 'm9', meta: JSON.stringify({ taskId: 'other', subtasks: ['脏数据'] }) })
    const hit = await patchAssistantTaskMessage(prisma, 's1', 't1', {
      metaMerge: { taskId: 't1', resumed: true },
      createIfMissing: { role: 'assistant', content: 'r', meta: { taskId: 't1', resumed: true } },
    })
    expect(hit).toBe(false)
    expect(created).toHaveLength(1)
    const meta = JSON.parse(created[0].meta as string)
    expect(meta).toEqual({ taskId: 't1', resumed: true })
    expect('subtasks' in meta).toBe(false)
    expect(created[0].seq).toBe(5) // 由事务统一取号
  })

  it('media 为空数组时把类型与 urls 一起清空（不留「有类型无图」的脏状态）', async () => {
    const { prisma, updated } = makePrisma({ id: 'm1', meta: JSON.stringify({ taskId: 't1' }) })
    await patchAssistantTaskMessage(prisma, 's1', 't1', { media: { urls: [], type: 'image' } })
    expect(updated[0].data.mediaType).toBeNull()
    expect(updated[0].data.mediaUrls).toBeNull()
  })

  it('坏 meta 不炸也不盲改：无法证明归属时宁可不覆盖原气泡', async () => {
    const { prisma, updated } = makePrisma({ id: 'm1', meta: '{ 坏 JSON' })
    const hit = await patchAssistantTaskMessage(prisma, 's1', 't1', { metaMerge: { ok: 1 } })
    expect(hit).toBe(false)
    expect(updated).toHaveLength(0)

    // 带兜底时改为新建一条，历史消息不会被无声覆盖，展示也能恢复
    const second = makePrisma({ id: 'm1', meta: '{ 坏 JSON' })
    await patchAssistantTaskMessage(second.prisma, 's1', 't1', {
      metaMerge: { taskId: 't1' },
      createIfMissing: { role: 'assistant', content: '已恢复', meta: { taskId: 't1' } },
    })
    expect(second.created).toHaveLength(1)
  })
})
