import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    const prisma = await getPrisma()

    // apiKey 留空/未传 = 保持现有 Key（只在显式给值时更新，杜绝编辑其他信息误清 Key）
    const provider = await prisma.apiProvider.update({
      where: { id },
      data: {
        name: body.name,
        baseUrl: body.baseUrl,
        configSchema: body.configSchema,
        adapterId: body.adapterId,
        configJson: body.configJson,
        isActive: body.isActive !== undefined ? body.isActive : undefined,
        ...(typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
          ? { apiKey: body.apiKey.trim() }
          : {}),
      },
    })

    return success(
      {
        ...provider,
        apiKey: provider.apiKey ? '****' + provider.apiKey.slice(-4) : null,
        createdAt: provider.createdAt.toISOString(),
        updatedAt: provider.updatedAt.toISOString(),
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
    await prisma.apiProvider.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
