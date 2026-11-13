import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, parsePagination } from '@/lib/api-handler'
import { embeddingClient, cosineSimilarity } from '@/lib/embedding'
import { getAuthUser } from '@/lib/api-auth'

const SIM_THRESHOLD = 0.3

// 提取工作流摘要：节点数、节点类型链、模型链路（用于卡片展示）
function extractWorkflowSummary(nodes: unknown): {
  nodeCount: number
  nodeTypes: string[]
  modelChain: string[]
} {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { nodeCount: 0, nodeTypes: [], modelChain: [] }
  }
  const nodeTypes = nodes
    .map((node) => (node as { type?: string } | null)?.type || '')
    .filter(Boolean)
  // 模型链路：从 image-generate/llm-chat 节点提取 model 字段（若有的话）
  const modelChain: string[] = []
  for (const node of nodes) {
    if (!node) continue
    const candidate = node as { type?: string; inputs?: { model?: unknown } }
    if (candidate.type === 'llm-chat' || candidate.type === 'image-generate') {
      const model = candidate.inputs?.model
      if (typeof model === 'string' && model) modelChain.push(model)
    }
  }
  return { nodeCount: nodes.length, nodeTypes, modelChain }
}

export const GET = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50, pageSize: 12 })
  const type = url.searchParams.get('type') || undefined
  const q = url.searchParams.get('q')?.trim() || ''

  // 匿名访问限制：防恶意刷量 —— 每页最多 12 条；语义检索需登录（embedding 有调用成本）
  const authUser = await getAuthUser(request)
  let effectivePageSize = pageSize
  if (!authUser) {
    effectivePageSize = Math.min(pageSize, 12)
    if (q) {
      return Response.json(
        { success: false, message: '请先登录后再使用语义检索' },
        { status: 401 }
      )
    }
  }

  // ===== 语义搜索：query embedding + 内存余弦比对（作品已预存向量） =====
  if (q) {
    const qVec = await embeddingClient.embed(q)
    if (qVec) {
      const all = await prisma.sharedWork.findMany({
        where: { status: 'APPROVED', ...(type ? { type } : {}), ...(url.searchParams.get('category') ? { category: url.searchParams.get('category') as string } : {}) },
        select: {
          id: true, slug: true, title: true, description: true, type: true, category: true, coverUrl: true, images: true, coverLayout: true,
          likeCount: true, viewCount: true, createdAt: true, embedding: true, featured: true,
          nodes: true,
          author: { select: { nickname: true, phone: true } },
        },
      })
      const relevant = all
        .filter((w) => w.embedding)
        .map((w) => {
          let sim = 0
          try { sim = cosineSimilarity(qVec, JSON.parse(w.embedding as string) as number[]) } catch { sim = 0 }
          return { w, sim }
        })
        .filter((x) => x.sim >= SIM_THRESHOLD)
        .sort((a, b) => b.sim - a.sim)
      const total = relevant.length
      const scored = relevant.slice((page - 1) * effectivePageSize, page * effectivePageSize)
      return {
        items: scored.map(({ w }) => ({
          id: w.id, slug: w.slug, title: w.title, description: w.description, type: w.type, category: w.category,
          coverUrl: w.coverUrl, images: w.images, coverLayout: w.coverLayout, likeCount: w.likeCount, viewCount: w.viewCount, featured: w.featured,
          authorName: w.author.nickname || `用户${(w.author.phone || '未知').slice(-4)}`,
          createdAt: w.createdAt.toISOString(),
          workflowSummary: w.type === 'workflow' ? extractWorkflowSummary(w.nodes) : undefined,
      })),
        total, page, pageSize: effectivePageSize,
        semantic: true,
      }
    }
    // 无 embedding 凭据 → fallback 关键词
    const where: Record<string, unknown> = { status: 'APPROVED', OR: [{ title: { contains: q } }, { description: { contains: q } }] }
    if (type) where.type = type
    if (url.searchParams.get('category')) where.category = url.searchParams.get('category')
    const [items, total] = await Promise.all([
      prisma.sharedWork.findMany({ where, orderBy: { createdAt: 'desc' as const }, skip: (page - 1) * pageSize, take: pageSize, select: {
        id: true, slug: true, title: true, description: true, type: true, category: true, coverUrl: true, images: true, coverLayout: true, likeCount: true, viewCount: true, createdAt: true, featured: true,
        nodes: true, connections: true,
        author: { select: { nickname: true, phone: true } },
      } }),
      prisma.sharedWork.count({ where }),
    ])
    return {
      items: items.map((w) => ({
        id: w.id, slug: w.slug, title: w.title, description: w.description, type: w.type, category: w.category,
        coverUrl: w.coverUrl, images: w.images, coverLayout: w.coverLayout, nodes: w.nodes, connections: w.connections, likeCount: w.likeCount, viewCount: w.viewCount, featured: w.featured,
        authorName: w.author.nickname || `用户${(w.author.phone || '未知').slice(-4)}`,
        createdAt: w.createdAt.toISOString(),
        workflowSummary: w.type === 'workflow' ? extractWorkflowSummary(w.nodes) : undefined,
      })),
      total, page, pageSize: effectivePageSize,
      semantic: false,
    }
  }

  const where: Record<string, unknown> = { status: 'APPROVED' }
  if (type) where.type = type
  if (url.searchParams.get('category')) where.category = url.searchParams.get('category')
  // 首页精选：仅返回管理员勾选的作品
  if (url.searchParams.get('featured') === '1') where.featured = true

  const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'new'
  // 热门：浏览+点赞综合 desc；最新：创建时间 desc
  const orderBy = sort === 'hot'
    ? [{ viewCount: 'desc' as const }, { likeCount: 'desc' as const }, { createdAt: 'desc' as const }]
    : { createdAt: 'desc' as const }

  const [items, total] = await Promise.all([
    prisma.sharedWork.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        type: true,
        category: true,
        coverUrl: true,
        images: true,
        coverLayout: true,
        connections: true,
        likeCount: true,
        viewCount: true,
        createdAt: true,
        featured: true,
        nodes: true,
        author: { select: { nickname: true, phone: true } },
      },
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
      category: w.category,
      coverUrl: w.coverUrl,
      images: w.images,
      coverLayout: w.coverLayout,
      nodes: w.nodes,
      connections: w.connections,
      likeCount: w.likeCount,
      viewCount: w.viewCount,
      featured: w.featured,
      authorName: w.author.nickname || `用户${(w.author.phone || '未知').slice(-4)}`,
      createdAt: w.createdAt.toISOString(),
      workflowSummary: w.type === 'workflow' ? extractWorkflowSummary(w.nodes) : undefined,
    })),
    total,
    page,
    pageSize: effectivePageSize,
  }
})
