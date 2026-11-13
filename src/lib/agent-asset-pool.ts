// Agent 会话素材池（Session Asset Pool）
//
// ===== 它解决什么 =====
// Agent 多轮对话里，模型需要「知道这个会话里都有哪些图」才能：
//   1) 理解指代 —— 用户说「第 3 张不行，重做」，模型得知道「第 3 张」是哪张
//   2) 引用产物 —— 「基于刚才那张再改一版」
//   3) 复用上传图 —— 「换成 4:3」（沿用上一轮的参考图）
//
// ===== 为什么不是新建一张表 / 不落磁盘 =====
// 「会话里有哪些图」这件事**数据早就有了**：chat_messages 表里
//   - 用户消息 meta.images  = 用户当轮上传的图
//   - 助手消息 mediaUrls    = 当轮生成的图
// 只是**从来没有人去读它**（旧的单次规划路径读了，第 2 期接工具循环时漏了）。
// 所以这里只做「读取 + 编号」，不新增存储、不写磁盘：
// 图仍然是上游临时 URL，我们不托管、过期即过期（与「默认不转存」的既定策略一致）。
//
// ===== 编号约定（对模型可见，是提示词契约的一部分） =====
//   图片N —— 用户在**本会话**上传的第 N 张（按时间正序）
//   素材N —— **本会话**生成产物的第 N 张（按时间正序）
// 正序编号（而不是「最近的排第 1」）是关键：倒序的话每生成一张，
// 旧编号就会整体位移，「素材3」上一轮还是这张、这一轮就变成另一张了。
//
// ===== 上限 =====
// 只保留最近 MAX_POOL 张。理由不是省事，是必须：
// 这些图 URL 会以多模态形式挂进每轮请求，不设上限会让 token 随轮次累积膨胀。

import { getPrisma } from '@/lib/prisma'

/**
 * 池子上限（上传图 + 生成图各自的上限）。
 *
 * 6/8 → 12/16（2026-10-04，用户要求放宽上下文）：
 * 实测「生成 5~6 张套图 → 逐张改」是主用法，8 张上限时一改就滑出窗口，
 * 用户说「改最后一张」会解析不到编号。放宽到 16 张能覆盖一次批量 + 数轮返工。
 *
 * 代价：编号清单只给「编号+类型」不给 URL（见 describePool），
 * 所以这里放大的是**清单长度**，token 增量很小（每张约 10 字符）。
 */
export const MAX_UPLOADED = 12
export const MAX_GENERATED = 16

export type PoolAsset = {
  /** 对模型可见的编号，如「图片1」「素材2」 */
  alias: string
  url: string
  type: string
}

export interface SessionAssetPool {
  /** 本会话用户上传的图（正序：图片1 是第 1 个上传的） */
  uploaded: PoolAsset[]
  /** 本会话生成的产物（正序：素材1 是第 1 个生成的） */
  generated: PoolAsset[]
}

const EMPTY: SessionAssetPool = { uploaded: [], generated: [] }

function safeParseUrls(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
  } catch {
    return []
  }
}

/**
 * 读取本会话的素材池。
 *
 * 只读「本会话」（sessionId 维度），不做跨会话回溯 —— 用户说「上次那张」属于另一个
 * 更复杂的问题（需要跨会话检索 + 权限），当前不做。
 */
export async function loadSessionAssetPool(
  sessionId: string | null | undefined,
  limit = 60,
): Promise<SessionAssetPool> {
  if (!sessionId) return EMPTY
  const prisma = await getPrisma()
  // 取最近 N 条消息，再在内存里按时间正序编号（DB 只给倒序，方便取「最近」）
  const msgs = await prisma.chatMessage.findMany({
    where: { sessionId, status: 'DONE' },
    orderBy: { seq: 'desc' },
    take: limit,
    select: { role: true, mediaUrls: true, mediaType: true, meta: true },
  })

  const uploaded: PoolAsset[] = []
  const generated: PoolAsset[] = []

  // DB 按 seq desc 返回（最新 → 最旧），需要在**消息层面**转成正序。
  //
  // ⚠️ 这里踩过坑：「消息之间要倒序」不等于「消息内部的 URL 也要倒序」。
  // 旧实现是逐张 unshift，会把**同一条消息里的 N 张图整块反转**。
  // 而 mediaUrls 的数组顺序正是前端成果区展示的顺序（executor 按 index 写入 imageUrls[i]），
  // 于是：存储 [1,2,3,4,5] → 编号成 素材1=第5张 … 素材5=第1张。
  // 用户说「改最后一张」→ 引用素材5 → 实际拿到第 1 张，改出来自然对不上。
  //
  // 正确做法：先按消息分组收集（内部保序），最后整体按时间正序展开。
  const collected: { uploaded: PoolAsset[]; generated: PoolAsset[] }[] = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const type = m.mediaType || 'image'
      const items = safeParseUrls(m.mediaUrls).map((url) => ({ alias: '', url, type }))
      if (items.length) collected.push({ uploaded: [], generated: items })
    } else if (m.role === 'user' && m.meta) {
      let meta: Record<string, unknown> | null = null
      try { meta = JSON.parse(m.meta) as Record<string, unknown> } catch { meta = null }
      const imgs = Array.isArray(meta?.images) ? meta!.images as unknown[] : []
      const items = imgs
        .filter((u): u is string => typeof u === 'string' && !!u)
        .map((url) => ({ alias: '', url, type: 'image' }))
      if (items.length) collected.push({ uploaded: items, generated: [] })
    }
  }
  // collected 是「新 → 旧」的消息顺序，reverse 后按时间正序展开；每条消息内部保持原顺序。
  for (const grp of collected.reverse()) {
    uploaded.push(...grp.uploaded)
    generated.push(...grp.generated)
  }

  // 只留最近 N 张（正序尾部 = 最近），再重新编号，保证编号连续、不因截断出现空洞
  const up = uploaded.slice(-MAX_UPLOADED)
  const gen = generated.slice(-MAX_GENERATED)
  return {
    uploaded: up.map((a, i) => ({ ...a, alias: `图片${i + 1}` })),
    generated: gen.map((a, i) => ({ ...a, alias: `素材${i + 1}` })),
  }
}

/**
 * 池子的「给模型看的」精简描述。
 *
 * 刻意只给编号 + 类型，**不给 URL**：
 *   - URL 又长又占 token，模型不需要它来「理解指代」
 *   - 真要引用某张图时，由 generate_image 的 assetIds 走编号解析（见 resolvePoolRef）
 * 这样上下文体积可控，也不把一堆临时外链塞进提示词。
 */
export function describePool(pool: SessionAssetPool): string {
  const parts: string[] = []
  if (pool.uploaded.length > 0) {
    parts.push(`用户本会话上传：${pool.uploaded.map((a) => a.alias).join('、')}`)
  }
  if (pool.generated.length > 0) {
    parts.push(`本会话已生成：${pool.generated.map((a) => `${a.alias}(${a.type})`).join('、')}`)
  }
  if (parts.length === 0) return ''
  return parts.join('；') + '。引用时直接用编号（如 assetIds:["图片1"] 或提到「素材2」）。'
}
