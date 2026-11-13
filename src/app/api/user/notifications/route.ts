import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, toPositiveInt } from '@/lib/api-handler'

/**
 * 我的站内通知（1 对 1 消息）。只读列表 + 未读数，按时间倒序。
 * 标记已读在 [id] 子路由（PATCH）。
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const url = new URL(request.url)
  // parseInt('abc') 是 NaN → Math.min/max 仍是 NaN → take:NaN 让 Prisma 报错
  const limit = toPositiveInt(url.searchParams.get('limit'), 20, 50)
  const unreadOnly = url.searchParams.get('unread') === '1'

  const where = { userId: authUser.userId, ...(unreadOnly ? { readAt: null } : {}) }
  const [items, unread] = await Promise.all([
    prisma.userNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.userNotification.count({ where: { userId: authUser.userId, readAt: null } }),
  ])

  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      content: n.content,
      link: n.link,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    })),
  }
})
