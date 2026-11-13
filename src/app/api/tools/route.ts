import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination, success } from '@/lib/api-handler'
import { analyzeToolSlots } from '@/lib/tool-slots'
import { getNodeDefinition } from '@/lib/canvas-nodes'
import { BASE_TOOL_CATEGORIES } from '@/lib/constants/categories'
import { CREATE_TOOL_SLUGS } from '@/lib/create-tools'

function genSlug(name: string): string {
  const base = (name || 'tool').replace(/[^\w一-龥]/g, '').slice(0, 20) || 'tool'
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

// ===== 工具列表 =====
export const GET = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50, pageSize: 12 })
  const category = url.searchParams.get('category') || undefined
  // 分组筛选：base = 基础工具（单能力工具，含文生图/图生图/视频/音频等全部基础类目）
  const group = url.searchParams.get('group') || undefined
  const q = url.searchParams.get('q')?.trim() || undefined
  const sort = url.searchParams.get('sort') || 'newest' // newest / popular
  const mine = url.searchParams.get('mine') === '1'
  const officialOnly = url.searchParams.get('official') === '1'

  let authorId: string | undefined
  if (mine) {
    const authUser = await requireAuth(request)
    authorId = authUser.userId
  }

  const where = {
    status: 'APPROVED',
    // 创作工作区工具（图像/视频生成的 composer 试点）不进工具箱列表：
    // 入口在导航「创作」（/create），列表里出现会变成两处重复入口。
    slug: { notIn: CREATE_TOOL_SLUGS },
    ...(category ? { category } : {}),
    ...(group === 'base' ? { category: { in: [...BASE_TOOL_CATEGORIES] } } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {}),
    ...(authorId ? { authorId } : {}),
    ...(officialOnly ? { isOfficial: true } : {}),
  }

  const [items, total] = await Promise.all([
    prisma.tool.findMany({
      where,
      orderBy: sort === 'popular' ? [{ useCount: 'desc' }, { likeCount: 'desc' }] : { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { author: { select: { id: true, nickname: true, avatarUrl: true } } },
    }),
    prisma.tool.count({ where }),
  ])

  // 分类聚合一并返回（前端导航用）
  const categories = mine
    ? []
    : await prisma.tool.groupBy({ by: ['category'], where: { status: 'APPROVED', category: { not: null }, slug: { notIn: CREATE_TOOL_SLUGS } }, _count: { _all: true } })

  return success({
    items: items.map(serializeTool),
    total,
    page,
    pageSize,
    categories: categories.map((c) => ({ name: c.category as string, count: c._count._all })),
  })
})

// ===== 发布工具（官方免审直接 APPROVED） =====
export const POST = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const authUser = await requireAuth(request)
  const body = await request.json()

  const { name, description, coverUrl, category, tags, workflow, slots, forkedFrom } = body ?? {}
  if (!name || typeof name !== 'string') throw new (await import('@/lib/api-handler')).ApiHandlerError('请给工具起个名字', 400)
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.connections)) {
    throw new (await import('@/lib/api-handler')).ApiHandlerError('工作流快照缺失（nodes/connections 必须是数组）', 400)
  }

  // 服务端兜底识别 slots（作者向导传来的 slots 与识别结果合并：识别为主，作者微调覆盖 label/hidden 等）
  const analyzed = analyzeToolSlots(workflow.nodes, workflow.connections)
  const merged = mergeSlots(workflow.nodes, analyzed.slots, Array.isArray(slots) ? slots : [])

  const user = await prisma.user.findUnique({ where: { id: authUser.userId } })

  const tool = await prisma.tool.create({
    data: {
      slug: genSlug(name),
      name: name.slice(0, 60),
      description: typeof description === 'string' ? description.slice(0, 500) : null,
      coverUrl: typeof coverUrl === 'string' ? coverUrl : null,
      category: typeof category === 'string' ? category : null,
      tags: typeof tags === 'string' ? tags : null,
      isOfficial: user?.role === 'ADMIN',
      status: user?.role === 'ADMIN' ? 'APPROVED' : 'PENDING',
      workflow: { nodes: workflow.nodes, connections: workflow.connections },
      slots: merged as unknown as object,
      forkedFrom: typeof forkedFrom === 'string' ? forkedFrom : null,
      authorId: authUser.userId,
    },
  })
  return success(tool, user?.role === 'ADMIN' ? '已发布（官方工具直接上架）' : '已提交，等待审核')
})

/**
 * 作者微调覆盖：同 id 的 slot 用作者版本覆盖识别版本。
 * 新协议：作者版本带 targets（发布向导 4 步版回传完整 slots，含确认后的建议 slot 合成 targets）→ 以作者为准。
 * 旧协议：只有 {id,label,hidden}（老客户端/Remix）→ 保留识别 targets 结构。
 */
function mergeSlots(nodes: unknown, analyzed: unknown[], authored: unknown[]) {
  const nodeById = new Map(
    (Array.isArray(nodes) ? nodes : [])
      .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && 'id' in node)
      .map((node) => [String((node as Record<string, unknown>).id), node]),
  )
  const validTargets = (slot: Record<string, unknown>) => {
    const targets = Array.isArray(slot.targets) ? slot.targets : []
    if (slot.type === 'choice') return targets.length === 0
    if (slot.type === 'result') return targets.length > 0
    if (targets.length === 0) return false
    return targets.every((target) => {
      if (!target || typeof target !== 'object') return false
      const nodeId = String((target as Record<string, unknown>).nodeId ?? '')
      const port = String((target as Record<string, unknown>).port ?? '')
      const node = nodeById.get(nodeId)
      if (!node || !port) return false
      const nodeDefinition = getNodeDefinition(String(node.type ?? ''))
      const inputKeys = new Set([
        ...Object.keys(nodeDefinition?.inputs ?? {}),
        ...Object.keys((node.inputs ?? {}) as Record<string, unknown>),
      ])
      return inputKeys.has(port)
    })
  }
  const byId = new Map<string, Record<string, unknown>>()
  for (const s of analyzed as Array<Record<string, unknown>>) byId.set(String(s.id), s)
  for (const a of authored as Array<Record<string, unknown>>) {
    const id = String(a.id ?? '')
    if (!id) continue
    const hasTargets = Array.isArray(a.targets) && a.targets.length > 0
    const isValidTargets = hasTargets && validTargets(a)
    const base = byId.get(id)
    if (hasTargets) {
      if (isValidTargets) {
        byId.set(id, a) // 新协议：完整版本（含建议 slot 的合成 targets）
      } else {
        byId.delete(id)
      }
    } else if (base) {
      byId.set(id, { ...base, ...a, targets: base.targets }) // 旧协议：targets 结构以识别为准
    } else if (a.type) {
      byId.set(id, a) // 作者自建完整 slot 也保留
    }
  }
  // 建议态（suggested）一律不落库：未确认的建议不生效
  return [...byId.values()].filter((s) => s.status !== 'suggested')
}

function serializeTool(t: {
  id: string; slug: string; name: string; description: string | null; coverUrl: string | null
  category: string | null; tags: string | null; isOfficial: boolean; status: string
  useCount: number; likeCount: number; forkedFrom: string | null; createdAt: Date
  author: { id: string; nickname: string | null; avatarUrl: string | null } | null
}) {
  return {
    id: t.id, slug: t.slug, name: t.name, description: t.description, coverUrl: t.coverUrl,
    category: t.category, tags: t.tags, isOfficial: t.isOfficial, status: t.status,
    useCount: t.useCount, likeCount: t.likeCount, forkedFrom: t.forkedFrom, createdAt: t.createdAt,
    author: t.author,
  }
}
