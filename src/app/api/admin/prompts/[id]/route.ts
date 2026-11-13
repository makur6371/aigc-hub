import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success, ApiHandlerError } from '@/lib/api-handler'

// PATCH /api/admin/prompts/[id] - 编辑提示词
export const PATCH = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params
    const body = await request.json()
    const { title, content, category, kind, isPublic, status, isOfficial } = body
    const ALLOWED_STATUS = ['PENDING', 'APPROVED', 'REJECTED']
    if (status !== undefined && !ALLOWED_STATUS.includes(status)) {
      throw new ApiHandlerError('无效状态', 400)
    }

    const prisma = await getPrisma()
    await prisma.promptTemplate.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(category !== undefined && { category }),
        ...(kind !== undefined && { kind }),
        ...(isPublic !== undefined && { isPublic }),
        ...(status !== undefined && { status }),
        ...(isOfficial !== undefined && { isOfficial }),
      },
    })

    return success(null, '保存成功')
  }
)

// DELETE /api/admin/prompts/[id] - 删除提示词
export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    await prisma.promptTemplate.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
