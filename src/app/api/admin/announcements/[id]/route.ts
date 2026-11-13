import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    if (!body.title || !body.content) {
      throw new ApiHandlerError('标题和内容不能为空', 400)
    }

    const prisma = await getPrisma()
    const announcement = await prisma.systemAnnouncement.update({
      where: { id },
      data: {
        title: body.title,
        content: body.content,
        type: body.type === 'featured' ? 'featured' : 'general',
        isActive: body.isActive,
        // publishedAt：空字符串/undefined → null(立即上线)；否则按 ISO 存
        publishedAt:
          typeof body.publishedAt === 'string' && body.publishedAt.trim()
            ? new Date(body.publishedAt)
            : null,
        // endsAt：空字符串/undefined → null(不过期)；否则按 ISO 存
        endsAt:
          typeof body.endsAt === 'string' && body.endsAt.trim()
            ? new Date(body.endsAt)
            : null,
      },
    })

    return success(
      {
        id: announcement.id,
        title: announcement.title,
        content: announcement.content,
        type: announcement.type,
        isActive: announcement.isActive,
        publishedAt: announcement.publishedAt?.toISOString() ?? null,
        endsAt: announcement.endsAt?.toISOString() ?? null,
        createdAt: announcement.createdAt.toISOString(),
        updatedAt: announcement.updatedAt.toISOString(),
      },
      '更新成功'
    )
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    await prisma.systemAnnouncement.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
