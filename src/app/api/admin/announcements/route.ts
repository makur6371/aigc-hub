import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'

const serializeAnnouncement = (a: { id: string; title: string; content: string; type: string; isActive: boolean; publishedAt: Date | null; endsAt: Date | null; createdAt: Date; updatedAt: Date }) => ({
  id: a.id,
  title: a.title,
  content: a.content,
  type: a.type,
  isActive: a.isActive,
  publishedAt: a.publishedAt?.toISOString() ?? null,
  endsAt: a.endsAt?.toISOString() ?? null,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
})

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const isActiveParam = url.searchParams.get('isActive')
  const where =
    isActiveParam !== null && isActiveParam !== '' ? { isActive: isActiveParam === 'true' } : {}

  const [items, total] = await Promise.all([
    prisma.systemAnnouncement.findMany({
      where,
      // 管理列表按创建时间倒序：publishedAt 可为空(立即上线)，用它排序会把这类记录挤到末页
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.systemAnnouncement.count({ where }),
  ])

  return {
    items: items.map(serializeAnnouncement),
    total,
    page,
    pageSize,
  }
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const { title, content, type, isActive, publishedAt, endsAt } = await request.json()
  if (!title || !content) {
    throw new Error('标题和内容不能为空')
  }

  const prisma = await getPrisma()
  const announcement = await prisma.systemAnnouncement.create({
    data: {
      title,
      content,
      type: type === 'featured' ? 'featured' : 'general',
      isActive: isActive ?? true,
      // publishedAt：空字符串/非法 → null(立即上线)；否则按 ISO 存
      publishedAt:
        typeof publishedAt === 'string' && publishedAt.trim()
          ? new Date(publishedAt)
          : undefined,
      // endsAt：空字符串/非法 → null(不过期)；否则按 ISO 存
      endsAt:
        typeof endsAt === 'string' && endsAt.trim()
          ? new Date(endsAt)
          : null,
    },
  })

  return serializeAnnouncement(announcement)
})
