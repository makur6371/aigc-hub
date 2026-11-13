import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'
import { writeAdminAction } from '@/lib/admin-audit'

// 管理员删除工具
export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const tool = await prisma.tool.findUnique({ where: { id } })
    if (!tool) {
      return success(null, '工具不存在或已删除')
    }

    // 删除是**不可逆**的，而且作者辛苦搭的工作流会直接从广场消失 ——
    // 必须留下「谁删了哪个工具、作者是谁」（Q-D42）。留痕与删除同事务。
    await prisma.$transaction(async (tx) => {
      await tx.tool.delete({ where: { id } })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: tool.authorId,
        action: 'tool_delete',
        note: `管理员删除了工具「${tool.name}」（status=${tool.status}${tool.isOfficial ? '、官方工具' : ''}）`,
      })
    })
    return success(null, '删除成功')
  }
)
