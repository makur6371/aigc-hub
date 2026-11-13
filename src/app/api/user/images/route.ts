import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'

export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50 })
  // 筛选：all=全部 / valid=未失效 / expired=已失效
  // 「已失效」= expiresAt 已过（上游链接过期或本站素材已清理）
  const filter = url.searchParams.get('filter') || 'all'
  const now = new Date()
  const where = {
    userId: authUser.userId,
    ...(filter === 'valid' ? { expiresAt: { gte: now } } : {}),
    ...(filter === 'expired' ? { expiresAt: { lt: now } } : {}),
  }

  const [items, total] = await Promise.all([
    prisma.imageGenerationRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { model: { select: { id: true, name: true, modelName: true, type: true } } },
    }),
    prisma.imageGenerationRecord.count({ where }),
  ])

  return {
    items: items.map((record) => ({
      id: record.id,
      /** 产物模态（统一契约：图片/视频/音频列表都带 kind，前端按 kind 分发） */
      kind: 'image' as const,
      userId: record.userId,
      modelId: record.modelId,
      prompt: record.prompt,
      negativePrompt: record.negativePrompt,
      width: record.width,
      height: record.height,
      imageUrl: record.imageUrl,
      costPoints: record.costPoints,
      status: record.status,
      errorMessage: record.errorMessage,
      expiresAt: record.expiresAt.toISOString(),
      /** 是否已失效（列表直接用来渲染占位图 + 标签，避免前端自己算时间） */
      expired: record.expiresAt.getTime() < Date.now(),
      createdAt: record.createdAt.toISOString(),
      model: record.model,
    })),
    total,
    page,
    pageSize,
  }
})

/** 批量删除：body { ids: string[] } */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { deleteMediaRecords } = await import('@/lib/user-media-records')
  const data = await deleteMediaRecords(request, 'image')
  return { ...data, message: `已删除 ${data.deleted} 条` }
})

/** 清理失效记录（expiresAt 已过） */
export const POST = apiHandler(async (request: NextRequest) => {
  const { purgeExpiredMediaRecords } = await import('@/lib/user-media-records')
  const data = await purgeExpiredMediaRecords(request, 'image')
  return { ...data, message: data.deleted > 0 ? `已清理 ${data.deleted} 条失效记录` : '没有需要清理的记录' }
})
