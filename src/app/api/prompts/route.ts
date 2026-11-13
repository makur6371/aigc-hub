import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import { getAuthUser } from '@/lib/api-auth'
import { embeddingClient, cosineSimilarity } from '@/lib/embedding'

// GET 公开读：匿名可浏览公开提示词（scope=public）；仅 scope=mine 需登录
// kind：creative=创作型成品提示词（瀑布流图选用）/ functional=功能型模板提示词（标题+描述选用）
export const GET = apiHandler(async (request: NextRequest) => {
  const url = new URL(request.url)
  const scope = url.searchParams.get('scope') || 'public'
  const authUser = scope === 'mine' ? await requireAuth(request) : await getAuthUser(request)
  const prisma = await getPrisma()
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const category = url.searchParams.get('category')
  const keyword = url.searchParams.get('keyword')
  const kind = url.searchParams.get('kind') // creative / functional / 空=全部

  const baseWhere: Record<string, unknown> =
    scope === 'mine'
      ? { creatorId: authUser!.userId }
      : scope === 'official'
        ? { isPublic: true, status: 'APPROVED', creatorId: null }
        : { isPublic: true, status: 'APPROVED' }

  if (kind === 'creative' || kind === 'functional') baseWhere.kind = kind
  if (category && category !== 'all') baseWhere.category = category

  // 语义检索：配了 EMBEDDING 凭据且有关键词时走向量比对（取 200 条候选池内算相似度）
  let semanticIds: string[] | null = null
  if (keyword && keyword.trim() && embeddingClient) {
    const vec = await embeddingClient.embed(keyword.trim())
    if (vec) {
      const candidates = await prisma.promptTemplate.findMany({
        where: { ...baseWhere, embedding: { not: null } },
        take: 200,
        select: { id: true, embedding: true },
      })
      semanticIds = candidates
        .map((c) => {
          try {
            return { id: c.id, sim: cosineSimilarity(vec, JSON.parse(c.embedding as string) as number[]) }
          } catch { return { id: c.id, sim: -1 } }
        })
        .filter((c) => c.sim > 0.35)
        .sort((a, b) => b.sim - a.sim)
        .map((c) => c.id)
    }
  }

  if (semanticIds) {
    if (semanticIds.length === 0) return { items: [], total: 0, page, pageSize }
    baseWhere.id = { in: semanticIds }
  } else if (keyword && keyword.trim()) {
    baseWhere.OR = [
      { title: { contains: keyword.trim() } },
      { content: { contains: keyword.trim() } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.promptTemplate.findMany({
      where: baseWhere,
      orderBy: [{ isPublic: 'desc' }, { useCount: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        creator: { select: { nickname: true, phone: true } },
        // 源上可关闭「缓存封面」：GitHub 系封面在境内常拉不动，关了就让卡片退化为纯文本
        source: { select: { cacheCover: true } },
      },
    }),
    prisma.promptTemplate.count({ where: baseWhere }),
  ])

  const ordered = semanticIds
    ? [...items].sort((a, b) => semanticIds.indexOf(a.id) - semanticIds.indexOf(b.id))
    : items

  return {
    items: ordered.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category,
      kind: p.kind,
      coverUrl: p.source && !p.source.cacheCover ? null : p.coverUrl,
      isPublic: p.isPublic,
      status: p.status,
      useCount: p.useCount,
      creatorName: p.creator?.nickname || (p.creator ? `用户${(p.creator.phone || '未知').slice(-4)}` : '官方'),
      isMine: !!authUser && p.creatorId === authUser.userId,
      createdAt: p.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  }
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const { title, content, category, isPublic, coverUrl, kind } = await request.json()
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('标题不能为空')
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('内容不能为空')
  }

  const prisma = await getPrisma()
  const prompt = await prisma.promptTemplate.create({
    data: {
      title: title.trim().slice(0, 60),
      content: content.trim(),
      category: typeof category === 'string' && category.trim() ? category.trim().slice(0, 20) : '通用',
      kind: kind === 'functional' ? 'functional' : 'creative',
      coverUrl: typeof coverUrl === 'string' && coverUrl ? coverUrl.slice(0, 2000) : null,
      isPublic: isPublic === true,
      status: isPublic === true ? 'PENDING' : 'APPROVED',
      creatorId: authUser.userId,
    },
  })

  // 异步补算 embedding（失败不阻塞创建）
  void embeddingClient?.embed(`${prompt.title}\n${prompt.content.slice(0, 500)}`).then((vec) => {
    if (vec) return prisma.promptTemplate.update({ where: { id: prompt.id }, data: { embedding: JSON.stringify(vec) } })
  }).catch(() => {})

  return prompt
})
