import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendChatMessage, appendChatMessages } from '@/lib/chat-persistence'

/**
 * Q-106：会话落库唯一实现。
 * 锁死三件事：① 一次批量写下的 seq 必须连续不重复（历史上「读 max 再各自 +1」会撞号，
 * 而 (sessionId,seq) 没有唯一约束，撞了不报错，只会让「找最后一条助手消息」的逻辑改错气泡）；
 * ② 取号与写入必须在同一个事务里（分开的两条语句之间插进来的并发写就是撞号来源）；
 * ③ meta / mediaUrls 的 JSON 化在模块内统一，调用方不再各写一份 JSON.stringify。
 */

function makePrisma(maxSeq = 7) {
  const created: Array<Record<string, unknown>> = []
  const updatedSessions: Array<Record<string, unknown>> = []
  const tx = {
    chatMessage: {
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: maxSeq } }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 'm' + created.length } }),
    },
    chatSession: { update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { updatedSessions.push(data); return {} }) },
  }
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) }
  return { prisma: prisma as never, tx, created, updatedSessions }
}

beforeEach(() => vi.clearAllMocks())

describe('appendChatMessages', () => {
  it('批量两条：seq 连续且各不重复', async () => {
    const { prisma, created } = makePrisma(7)
    const seqs = await appendChatMessages(prisma, 's1', [
      { role: 'user', content: '画一张猫' },
      { role: 'assistant', content: '已生成图片', mediaType: 'image', mediaUrls: ['https://x/a.png'] },
    ])
    expect(seqs).toEqual([8, 9])
    expect(created.map((c) => c.seq)).toEqual([8, 9])
  })

  it('取号与写入在同一个 $transaction 内', async () => {
    const { prisma, tx } = makePrisma(0)
    await appendChatMessages(prisma, 's1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }])
    // 关键：整个批量只开一个事务、只取一次号 —— 分开取号正是撞号的来源
    expect((prisma as unknown as { $transaction: { mock: { calls: unknown[] } } }).$transaction.mock.calls.length).toBe(1)
    expect(tx.chatMessage.aggregate.mock.calls.length).toBe(1)
    expect(tx.chatMessage.create.mock.calls.length).toBe(2)
  })

  it('meta / mediaUrls 自动 JSON 化，未传时保持 NULL', async () => {
    const { prisma, created } = makePrisma(3)
    await appendChatMessages(prisma, 's1', [
      { role: 'assistant', content: 'x', meta: { taskId: 't1', subtasks: [] }, mediaUrls: ['u1'] },
      { role: 'assistant', content: 'y' },
    ])
    expect(JSON.parse(created[0].meta as string)).toEqual({ taskId: 't1', subtasks: [] })
    expect(JSON.parse(created[0].mediaUrls as string)).toEqual(['u1'])
    expect(created[0].mediaType).toBeNull()
    expect(created[1].meta).toBeNull()
    expect(created[1].mediaUrls).toBeNull()
  })

  it('opts.modelId 会顺手更新会话模型；不传则不动 chatSession', async () => {
    const a = makePrisma(1)
    await appendChatMessages(a.prisma, 's1', [{ role: 'user', content: 'q' }], { modelId: 'model-9' })
    expect(a.updatedSessions).toEqual([{ modelId: 'model-9' }])

    const b = makePrisma(1)
    await appendChatMessage(b.prisma, 's1', { role: 'assistant', content: 'a' })
    expect(b.updatedSessions).toEqual([])
  })

  it('空数组不碰数据库', async () => {
    const { prisma, tx } = makePrisma(5)
    await expect(appendChatMessages(prisma, 's1', [])).resolves.toEqual([])
    expect(tx.chatMessage.aggregate).not.toHaveBeenCalled()
  })
})
