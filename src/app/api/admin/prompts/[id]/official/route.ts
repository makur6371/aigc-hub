import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'

// POST /api/admin/prompts/[id]/official - 设置/取消官方提示词
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params
    const body = await request.json()
    const { isOfficial } = body

    const prisma = await getPrisma()
    await prisma.promptTemplate.update({
      where: { id },
      data: { isOfficial },
    })

    return success(null, isOfficial ? '已设为官方' : '已取消官方')
  }
)
