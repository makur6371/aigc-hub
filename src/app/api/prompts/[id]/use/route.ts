import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'

// 使用计数 +1（点击复制/使用）
export const POST = apiHandler<{ id: string }>(
  async (_request: NextRequest, { params }) => {
    await requireAuth(_request)
    const { id } = await params
    const prisma = await getPrisma()

    const existing = await prisma.promptTemplate.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiHandlerError('提示词不存在', 404)
    }

    await prisma.promptTemplate.update({
      where: { id },
      data: { useCount: { increment: 1 } },
    })

    return null
  }
)
