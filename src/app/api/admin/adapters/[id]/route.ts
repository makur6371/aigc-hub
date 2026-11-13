import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    const { name, description, type, source, isActive } = body

    const prisma = await getPrisma()
    const existing = await prisma.providerAdapter.findUnique({ where: { id } })

    if (!existing) {
      throw new ApiHandlerError('适配器不存在', 404)
    }
    if (existing.isBuiltin) {
      throw new ApiHandlerError('内置适配器不可编辑', 400)
    }

    const data: Record<string, unknown> = {}
    if (name !== undefined) data.name = String(name)
    if (description !== undefined) data.description = description ? String(description) : null
    if (type !== undefined) {
      if (!['TYPESCRIPT', 'JSON'].includes(type)) {
        throw new ApiHandlerError('类型必须是 TYPESCRIPT 或 JSON', 400)
      }
      data.type = type
    }
    if (source !== undefined) data.source = String(source)
    if (isActive !== undefined) data.isActive = Boolean(isActive)

    const adapter = await prisma.providerAdapter.update({
      where: { id },
      data,
    })

    return success(
      { ...adapter, createdAt: adapter.createdAt.toISOString(), updatedAt: adapter.updatedAt.toISOString() },
      '更新成功'
    )
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const existing = await prisma.providerAdapter.findUnique({ where: { id } })

    if (!existing) {
      throw new ApiHandlerError('适配器不存在', 404)
    }
    if (existing.isBuiltin) {
      throw new ApiHandlerError('内置适配器不可删除', 400)
    }

    await prisma.providerAdapter.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
