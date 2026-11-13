import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'

function extractWorkPrompts(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return []
  const values: string[] = []
  for (const node of nodes) {
    const inputs = (node as { inputs?: Record<string, unknown> } | null)?.inputs
    if (!inputs) continue
    const candidates = [
      inputs.prompt,
      ...(Array.isArray(inputs.prompts) ? inputs.prompts : []),
    ].filter((value): value is unknown => typeof value === 'string' || typeof value === 'number')
    for (const value of candidates) {
      const text = String(value).trim()
      if (text) values.push(text.slice(0, 1200))
    }
  }
  return [...new Set(values)].slice(0, 5)
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const status = url.searchParams.get('status') || undefined
  const where = status === 'FEATURED' ? { status: 'APPROVED', featured: true } : status ? { status } : {}

  const [items, total] = await Promise.all([
    prisma.sharedWork.findMany({
      where,
      // 排序：已通过优先 → 待审核 → 已驳回，其次创建时间倒序
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { author: { select: { nickname: true, phone: true } } },
    }),
    prisma.sharedWork.count({ where }),
  ])

  return {
    items: items.map((w) => ({
      id: w.id,
      slug: w.slug,
      title: w.title,
      description: w.description,
      type: w.type,
      coverUrl: w.coverUrl,
      category: w.category,
      images: Array.isArray(w.images) ? w.images.filter((item): item is string => typeof item === 'string') : [],
      status: w.status,
      featured: w.featured,
      prompts: extractWorkPrompts(w.nodes),
      authorName: w.author.nickname || `用户${(w.author.phone || '未知').slice(-4)}`,
      createdAt: w.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  }
})
