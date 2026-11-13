import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success, parsePagination } from '@/lib/api-handler'

// 管理员工具列表（含待审核），支持状态筛选 + 关键词
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const q = url.searchParams.get('q')?.trim()
  // 用共享 helper：Number('abc') 是 NaN，Math.max(1, NaN) 仍是 NaN → skip/take 传给 Prisma 会报错
  const { page, pageSize } = parsePagination(url, { pageSize: 10, maxPageSize: 50 })

  const prisma = await getPrisma()
  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { slug: { contains: q } }] } : {}),
  }
  const [items, total] = await Promise.all([
    prisma.tool.findMany({
      where,
      // 排序：已上架优先 → 待审核 → 已驳回，其次按创建时间倒序。
      // 管理员主要关心「在线的有哪些」，下架/驳回的沉底更符合直觉。
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, slug: true, name: true, description: true, coverUrl: true, category: true,
        isOfficial: true, status: true, useCount: true, likeCount: true, createdAt: true,
        author: { select: { nickname: true, phone: true } },
      },
    }),
    prisma.tool.count({ where }),
  ])
  return success({ items, total })
})
