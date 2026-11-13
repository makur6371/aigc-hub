import { describe, it, expect, vi } from 'vitest'

/**
 * 会话素材池的编号必须与「前端成果区展示顺序」一致。
 *
 * 真实 bug（2026-10-01 生产实测）：
 * loadSessionAssetPool 遍历消息按 seq desc（新→旧），对每个 URL 调 unshift 来「保持正序」。
 * 这对「消息之间」是对的，但**同一条消息内部的多个 URL 也被逐个 unshift → 整块反转**。
 *
 * 实测数据（session cmupaxaqn...，seq=2 生成 5 张）：
 *   mediaUrls 存储顺序 = [ts185, ts183, ts181, ts186, ts187]（= 用户在成果区看到的顺序）
 *   素材池编号后      = 素材1:ts187 素材2:ts186 素材3:ts181 素材4:ts183 素材5:ts185
 *   → 「素材5」指向的是成果区第 1 张，不是第 5 张。
 * 用户说「改最后一张」时，Agent 引用素材5 → 拿到的是另一张图。
 */

const M = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/lib/prisma', () => ({
  getPrisma: async () => ({
    chatMessage: { findMany: async () => M.rows },
  }),
}))

import { loadSessionAssetPool } from '@/lib/agent-asset-pool'

/** 造一条助手消息（DB 里 seq desc 返回，所以数组顺序是 新→旧） */
function assistantMsg(seq: number, urls: string[]) {
  return { role: 'assistant', mediaUrls: JSON.stringify(urls), mediaType: 'image', meta: null, seq }
}

describe('会话素材池编号 = 成果区展示顺序', () => {
  it('单条消息含多张图时，编号必须与存储顺序一致（不被反转）', async () => {
    // 存储顺序 A,B,C,D,E —— 这就是用户在成果区看到的顺序
    M.rows = [assistantMsg(2, ['U-A', 'U-B', 'U-C', 'U-D', 'U-E'])]
    const pool = await loadSessionAssetPool('s1')
    expect(pool.generated.map((a) => a.url)).toEqual(['U-A', 'U-B', 'U-C', 'U-D', 'U-E'])
    expect(pool.generated[4].alias).toBe('素材5')
    expect(pool.generated[4].url).toBe('U-E') // 素材5 必须是第 5 张
  })

  it('多条消息时：旧消息的图编号在前（时间正序），且每条内部顺序不乱', async () => {
    // DB 返回 新→旧
    M.rows = [
      assistantMsg(6, ['N-1']),
      assistantMsg(2, ['U-A', 'U-B', 'U-C']),
    ]
    const pool = await loadSessionAssetPool('s1')
    // 期望：先 seq2 的三张（内部保持 A,B,C），再 seq6 的一张
    expect(pool.generated.map((a) => a.url)).toEqual(['U-A', 'U-B', 'U-C', 'N-1'])
    expect(pool.generated.map((a) => a.alias)).toEqual(['素材1', '素材2', '素材3', '素材4'])
  })

  it('上传图同理：单条消息多张上传图不被反转', async () => {
    M.rows = [
      { role: 'user', mediaUrls: null, mediaType: null, seq: 1,
        meta: JSON.stringify({ images: ['P-1', 'P-2', 'P-3', 'P-4'] }) },
    ]
    const pool = await loadSessionAssetPool('s1')
    expect(pool.uploaded.map((a) => a.url)).toEqual(['P-1', 'P-2', 'P-3', 'P-4'])
    expect(pool.uploaded[3].alias).toBe('图片4')
  })
})
