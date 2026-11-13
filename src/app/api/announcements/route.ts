import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, toPositiveInt } from '@/lib/api-handler'

export const GET = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const url = new URL(request.url)
  // parseInt('abc') 是 NaN → Math.min/max 仍是 NaN → take:NaN 让 Prisma 报错
  const limit = toPositiveInt(url.searchParams.get('limit'), 20, 50)
  const now = new Date()

  // 只返回「启用」且「已到上线时间」的公告（publishedAt 为空=立即上线）
  // endsAt（下线时间）非空且已过 → 自动隐藏，活动公告到点收摊
  const items = await prisma.systemAnnouncement.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  // 生效时间 = publishedAt ?? createdAt；SQL 里 NULL 会被排到末尾，故在内存里按生效时间重排
  const sorted = [...items].sort(
    (a, b) => (b.publishedAt ?? b.createdAt).getTime() - (a.publishedAt ?? a.createdAt).getTime()
  )

  return sorted.map((a) => ({
    id: a.id,
    title: a.title,
    content: a.content,
    type: a.type,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    endsAt: a.endsAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }))
})
