import { describe, it, expect, vi } from 'vitest'

/**
 * 会话素材池 —— 让 Agent 能理解「第 3 张」「刚才那张」。
 *
 * 背景：数据本来就存在 chat_messages 里（用户 meta.images / 助手 mediaUrls），
 * 只是没人读。第 2 期接工具循环时漏了读取，导致跨轮指代失效。
 * 这里锁死「读取 + 编号」的语义，尤其是**正序编号不可位移**。
 */

const rows: unknown[] = []
vi.mock('@/lib/prisma', () => ({
  getPrisma: async () => ({
    chatMessage: { findMany: async () => rows },
  }),
}))

import { loadSessionAssetPool, describePool, MAX_UPLOADED, MAX_GENERATED } from '@/lib/agent-asset-pool'

const msg = (o: Record<string, unknown>) => ({ role: 'user', mediaUrls: null, mediaType: null, meta: null, ...o })
const genMsg = (urls: string[]) => msg({ role: 'assistant', mediaUrls: JSON.stringify(urls), mediaType: 'image' })
const upMsg = (urls: string[]) => msg({ role: 'user', meta: JSON.stringify({ images: urls }) })

describe('loadSessionAssetPool', () => {
  it('无 sessionId → 空池（不查库）', async () => {
    rows.length = 0
    const p = await loadSessionAssetPool(null)
    expect(p).toEqual({ uploaded: [], generated: [] })
  })

  it('区分「上传图」与「生成图」，各自编号', async () => {
    // DB 返回倒序（最新在前）
    rows.length = 0
    rows.push(genMsg(['https://g/2.png']), upMsg(['https://u/2.png']), genMsg(['https://g/1.png']), upMsg(['https://u/1.png']))
    const p = await loadSessionAssetPool('s1')
    expect(p.uploaded.map((a) => [a.alias, a.url])).toEqual([['图片1', 'https://u/1.png'], ['图片2', 'https://u/2.png']])
    expect(p.generated.map((a) => [a.alias, a.url])).toEqual([['素材1', 'https://g/1.png'], ['素材2', 'https://g/2.png']])
  })

  it('正序编号：新生成一张后，旧编号不位移（素材3 始终指同一张）', async () => {
    rows.length = 0
    // 真实 DB 返回倒序（最新在前），夹具必须一致
    rows.push(genMsg(['https://g/3.png']), genMsg(['https://g/2.png']), genMsg(['https://g/1.png']))
    const p = await loadSessionAssetPool('s1')
    expect(p.generated.map((a) => a.alias)).toEqual(['素材1', '素材2', '素材3'])
    expect(p.generated[2].url).toBe('https://g/3.png')
  })

  it('超过上限时保留最近 N 张，且编号从 1 连续（不留空洞）', async () => {
    rows.length = 0
    const urls = Array.from({ length: MAX_GENERATED + 3 }, (_, i) => `https://g/${i + 1}.png`)
    // 倒序入库
    for (const u of [...urls].reverse()) rows.push(genMsg([u]))
    const p = await loadSessionAssetPool('s1')
    expect(p.generated).toHaveLength(MAX_GENERATED)
    // 编号仍从 素材1 开始（不是 素材4）
    expect(p.generated[0].alias).toBe('素材1')
    // 内容是最新的那批
    expect(p.generated[p.generated.length - 1].url).toBe(urls[urls.length - 1])
  })

  it('坏 JSON / 空 meta 不崩，直接跳过', async () => {
    rows.length = 0
    rows.push(msg({ role: 'assistant', mediaUrls: 'not-json' }), msg({ role: 'user', meta: '{{{' }), genMsg(['https://g/1.png']))
    const p = await loadSessionAssetPool('s1')
    expect(p.generated.map((a) => a.url)).toEqual(['https://g/1.png'])
    expect(p.uploaded).toEqual([])
  })

  it('一条消息带多张图，按顺序展开', async () => {
    rows.length = 0
    rows.push(genMsg(['https://g/a.png', 'https://g/b.png']))
    const p = await loadSessionAssetPool('s1')
    expect(p.generated.map((a) => a.alias)).toEqual(['素材1', '素材2'])
  })

  it('视频产物保留自身类型', async () => {
    rows.length = 0
    rows.push(msg({ role: 'assistant', mediaUrls: JSON.stringify(['https://g/v.mp4']), mediaType: 'video' }))
    const p = await loadSessionAssetPool('s1')
    expect(p.generated[0]).toMatchObject({ type: 'video' })
  })
})

describe('describePool', () => {
  it('空池 → 空串（不往上下文塞废话）', () => {
    expect(describePool({ uploaded: [], generated: [] })).toBe('')
  })

  it('只给编号不给 URL（控 token）；上传和生成分开列', () => {
    const t = describePool({
      uploaded: [{ alias: '图片1', url: 'https://long/xxx.png', type: 'image' }],
      generated: [{ alias: '素材1', url: 'https://long/yyy.png', type: 'image' }],
    })
    expect(t).toContain('图片1')
    expect(t).toContain('素材1')
    expect(t).not.toContain('https://')
  })
})

describe('上限常量', () => {
  it('有明确上限（否则每轮重发所有图会撑爆 token）', () => {
    expect(MAX_UPLOADED).toBeGreaterThan(0)
    // 放宽过一次（6→12，2026-10-04）。这里给宽松上界：真正要防的是「无上限」，
    // 不是某个具体数值 —— 写死会让调参变成改测试。
    expect(MAX_UPLOADED).toBeLessThanOrEqual(20)
    expect(MAX_GENERATED).toBeGreaterThan(0)
    expect(MAX_GENERATED).toBeLessThanOrEqual(24)
  })
})
