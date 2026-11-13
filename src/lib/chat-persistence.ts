import type { PrismaClient } from '@prisma/client'

/**
 * 会话消息落库的唯一实现（台账 Q-106 / Q-203 规划里的 chat-persistence）。
 *
 * 为什么要收：`读 max(seq) → +1 → create` 这套在 9 处各写了一遍
 * （agent/send 5 处、image/audio/video generate 各 1 处、resume 1 处），
 * 除了重复本身，还有一个真实缺陷：
 *   `chat_messages` 上 **(sessionId, seq) 只有普通索引、没有唯一约束**，
 *   所以并发写同一会话时撞号不会报错，只会静默产出两条同号消息 ——
 *   而 confirm / revise / 回写等多处逻辑靠 `orderBy seq desc` 找「最后一条助手消息」，
 *   同号会让它们改错气泡（用户表现为「刚生成完看得到，刷新后位置错乱」）。
 *
 * 现在取号与写入放进同一个事务：SQLite 单写 + 事务内串行，消除读-写之间的竞态窗口。
 * 一次要写多条（用户气泡 + 助手气泡）时用数组版本，它们共享同一次取号，号必不重复。
 */

export interface ChatMessageInput {
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string | null
  /** null / image / video / audio */
  mediaType?: string | null
  /** 传入数组会自动 JSON 化；不传则保持 NULL */
  mediaUrls?: string[]
  /** 传对象会自动 JSON 化；显式 null 写 NULL */
  meta?: Record<string, unknown> | null
  /** STREAMING / DONE / FAILED，默认 DONE */
  status?: string
}

export interface AppendChatOptions {
  /** 顺手把会话的 modelId 更新为本次实际使用的模型（原各处都手写这一步） */
  modelId?: string | null
}

/** 按顺序追加若干条消息，返回各自分配到的 seq（顺序一一对应） */
export async function appendChatMessages(
  prisma: PrismaClient,
  sessionId: string,
  messages: ChatMessageInput[],
  opts: AppendChatOptions = {},
): Promise<number[]> {
  if (messages.length === 0) return []
  return prisma.$transaction(async (tx) => {
    const last = await tx.chatMessage.aggregate({ where: { sessionId }, _max: { seq: true } })
    let seq = last._max.seq ?? 0
    if (opts.modelId !== undefined) {
      await tx.chatSession.update({ where: { id: sessionId }, data: { modelId: opts.modelId } })
    }
    const assigned: number[] = []
    for (const m of messages) {
      seq += 1
      assigned.push(seq)
      await tx.chatMessage.create({
        data: {
          sessionId,
          role: m.role,
          content: m.content,
          reasoning: m.reasoning ?? null,
          mediaType: m.mediaType ?? null,
          mediaUrls: m.mediaUrls ? JSON.stringify(m.mediaUrls) : null,
          meta: m.meta === undefined ? null : JSON.stringify(m.meta),
          status: m.status ?? 'DONE',
          seq,
        },
      })
    }
    return assigned
  })
}

/** 单条版本（多数调用点只需要这个） */
export async function appendChatMessage(
  prisma: PrismaClient,
  sessionId: string,
  message: ChatMessageInput,
  opts: AppendChatOptions = {},
): Promise<number> {
  const [seq] = await appendChatMessages(prisma, sessionId, [message], opts)
  return seq ?? 0
}

/**
 * 从子任务数组里收集要挂到气泡上的媒体（confirm / resume 原来各写一份，
 * 一份用 flatMap、一份用循环，视频优先级的判定细节已经出现分叉）。
 * 统一按这里的行为：任一 videoUrl 出现即整条按 video 归类。
 */
export function collectSubtaskMedia(subtasks: Record<string, unknown>[]): {
  urls: string[]
  type: 'image' | 'video' | null
} {
  const urls: string[] = []
  let type: 'image' | 'video' | null = null
  for (const s of subtasks) {
    if (s.status !== 'success') continue
    if (Array.isArray(s.imageUrls)) {
      for (const url of s.imageUrls) {
        urls.push(String(url))
        if (!type) type = 'image'
      }
    } else if (s.imageUrl) {
      urls.push(String(s.imageUrl))
      if (!type) type = 'image'
    }
    if (s.videoUrl) {
      urls.push(String(s.videoUrl))
      type = 'video'
    }
  }
  return { urls, type }
}

export interface PatchAssistantMessageInput {
  /** 要合并进 meta 的字段（浅合并，保留原 meta 的其余键） */
  metaMerge?: Record<string, unknown>
  /** 合并后删掉的 meta 键（confirm 完成时要清掉 pendingActions，否则刷新又冒出确认卡） */
  metaOmit?: string[]
  content?: string
  status?: string
  /** 传入即覆盖媒体；不传保持原值 */
  media?: { type: 'image' | 'video' | null; urls: string[] }
  /** 找不到同任务气泡时是否新建（resume 的兜底路径需要） */
  createIfMissing?: ChatMessageInput
}

/**
 * 回写「属于这个任务的那条助手气泡」（Q-106 残留部分）。
 *
 * 为什么必须限定 taskId：同一个会话可能跑过多个任务，只按 `seq desc` 取最后一条
 * 会改到别的任务的气泡（三处原实现都专门写了这条注释，也各自实现了一遍）。
 *
 * 「改了库却没改展示」是本项目反复出现的事故形状：库里图有了、刷新历史却仍是
 * 「待确认」旧 meta（confirm），或仍是第一版方案（revise）。所以统一到一个入口。
 *
 * @returns true = 命中并更新；false = 未命中（如指定则已按 createIfMissing 新建）
 */
export async function patchAssistantTaskMessage(
  prisma: PrismaClient,
  sessionId: string,
  taskId: string,
  patch: PatchAssistantMessageInput,
): Promise<boolean> {
  const latest = await prisma.chatMessage.findFirst({
    where: { sessionId, role: 'assistant' },
    orderBy: { seq: 'desc' },
    select: { id: true, meta: true },
  })
  let prevMeta: Record<string, unknown> = {}
  if (latest?.meta) {
    try {
      prevMeta = JSON.parse(latest.meta) as Record<string, unknown>
    } catch {
      prevMeta = {}
    }
  }

  if (latest && prevMeta.taskId === taskId) {
    const merged: Record<string, unknown> = { ...prevMeta, ...(patch.metaMerge ?? {}) }
    for (const key of patch.metaOmit ?? []) delete merged[key]
    const data: Record<string, unknown> = { meta: JSON.stringify(merged) }
    if (patch.content !== undefined) data.content = patch.content
    if (patch.status !== undefined) data.status = patch.status
    if (patch.media) {
      data.mediaType = patch.media.urls.length > 0 ? patch.media.type : null
      data.mediaUrls = patch.media.urls.length > 0 ? JSON.stringify(patch.media.urls) : null
    }
    await prisma.chatMessage.update({ where: { id: latest.id }, data })
    return true
  }

  if (patch.createIfMissing) {
    await appendChatMessage(prisma, sessionId, patch.createIfMissing)
  }
  return false
}
