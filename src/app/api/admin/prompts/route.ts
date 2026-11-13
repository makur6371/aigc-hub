import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success, parsePagination } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'

// GET /api/admin/prompts - 提示词列表（管理员，分页 + 服务端筛选）
//
// 为什么必须分页：生产库已有 996 条提示词，且每条含完整 content（富文本）。
// 原先一次性全量返回（估算 1~2MB），既慢又浪费流量 —— 见 INV-2026-0919-06 的 Q-A01。
//
// 筛选下推到服务端：前端原本在本地 filter（kind / status / 关键词），
// 分页后本地过滤只能过滤「当前页」，会漏掉其它页的命中项 —— 必须一起改。
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { pageSize: 20, maxPageSize: 100 })
  const kind = url.searchParams.get('kind') || undefined
  const status = url.searchParams.get('status') || undefined
  const keyword = (url.searchParams.get('keyword') || '').trim()

  const where: Prisma.PromptTemplateWhereInput = {}
  if (kind && kind !== 'all') where.kind = kind
  if (status && status !== 'all') where.status = status
  if (keyword) {
    // 关键词跨字段匹配：标题 / 正文 / 分类 / 作者昵称（与前端原来的过滤维度一致）
    where.OR = [
      { title: { contains: keyword } },
      { content: { contains: keyword } },
      { category: { contains: keyword } },
      { creator: { nickname: { contains: keyword } } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.promptTemplate.findMany({
      where,
      // 排序：已上架优先 → 待审核 → 已驳回，其次创建时间倒序
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        creator: {
          select: { id: true, nickname: true, avatarUrl: true },
        },
        source: { select: { name: true, cacheCover: true } },
      },
    }),
    prisma.promptTemplate.count({ where }),
  ])

  return success({
    total,
    page,
    pageSize,
    items: items.map((p) => ({
        id: p.id,
        title: p.title,
        content: p.content,
        category: p.category,
        kind: p.kind,
        coverUrl: p.source && !p.source.cacheCover ? null : p.coverUrl,
        sourceName: p.source?.name || null,
        isPublic: p.isPublic,
        status: p.status,
        isOfficial: p.isOfficial,
        useCount: p.useCount,
        creatorId: p.creatorId,
        creatorName: p.creator?.nickname || '未知',
        createdAt: p.createdAt.toISOString(),
    })),
  })
})
