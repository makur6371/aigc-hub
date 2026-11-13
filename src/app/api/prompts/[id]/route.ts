import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { embeddingClient } from '@/lib/embedding'

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const body = await request.json()
    const prisma = await getPrisma()

    const existing = await prisma.promptTemplate.findFirst({
      where: { id, creatorId: authUser.userId },
    })
    if (!existing) {
      throw new ApiHandlerError('提示词不存在或无权限', 404)
    }

    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 60)
    if (typeof body.content === 'string' && body.content.trim()) data.content = body.content.trim()
    if (typeof body.category === 'string') data.category = body.category.trim().slice(0, 20) || '通用'
    if (typeof body.isPublic === 'boolean') {
      data.isPublic = body.isPublic
      if (body.isPublic && !existing.isPublic) data.status = 'PENDING'
    }
    if (data.title || data.content) {
      if (existing.isPublic) data.status = 'PENDING'
    }
    if (body.kind === 'creative' || body.kind === 'functional') data.kind = body.kind

    const prompt = await prisma.promptTemplate.update({ where: { id }, data })

    // 标题/内容变了 → 重算 embedding（异步，失败不阻塞）
    if (data.title || data.content) {
      void embeddingClient?.embed(`${prompt.title}\n${prompt.content.slice(0, 500)}`).then((vec) => {
        if (vec) return prisma.promptTemplate.update({ where: { id: prompt.id }, data: { embedding: JSON.stringify(vec) } })
      }).catch(() => {})
    }
    return success(prompt, '已更新')
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const existing = await prisma.promptTemplate.findFirst({
      where: { id, creatorId: authUser.userId },
    })
    if (!existing) {
      throw new ApiHandlerError('提示词不存在或无权限', 404)
    }

    await prisma.promptTemplate.delete({ where: { id } })
    return success(null, '已删除')
  }
)
