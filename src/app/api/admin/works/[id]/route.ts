import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { writeAdminAction } from '@/lib/admin-audit'

// 后台作品属性更新：首页精选开关、编辑标题/描述/分类等
export const PATCH = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })

    const { id } = await params
    const body = await request.json()
    const { featured, title, description, category, status } = body
    if (status !== undefined && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      throw new ApiHandlerError('无效状态', 400)
    }

    const prisma = await getPrisma()
    const work = await prisma.sharedWork.findUnique({ where: { id } })
    if (!work) {
      throw new ApiHandlerError('作品不存在', 404)
    }

    const updateData: Record<string, unknown> = {}
    if (typeof featured === 'boolean') {
      updateData.featured = featured
    }
    if (title !== undefined) {
      updateData.title = title
    }
    if (description !== undefined) {
      updateData.description = description
    }
    if (category !== undefined) {
      updateData.category = category
    }
    if (status !== undefined) {
      updateData.status = status
    }

    // 这里能**直接改 status 上下架**（绕开审核流的 reviewedBy/reviewedAt），
    // 也能把作品设为首页精选 —— 都改变对外可见性，必须可追责（Q-D42）
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.sharedWork.update({ where: { id }, data: updateData })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: work.authorId,
        action: 'work_update',
        note: `管理员修改作品「${work.title}」：${JSON.stringify(updateData)}（改前 status=${work.status}、精选=${work.featured}）`,
      })
      return row
    })

    const message = status !== undefined
      ? (status === 'APPROVED' ? '已上架' : '已下架')
      : featured !== undefined
      ? (featured ? '已设为首页精选' : '已取消精选')
      : '保存成功'

    return success({ id: updated.id, status: updated.status, featured: updated.featured }, message)
  }
)

// 管理员删除作品
export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const work = await prisma.sharedWork.findUnique({ where: { id } })
    if (!work) {
      return success(null, '作品不存在或已删除')
    }

    await prisma.$transaction(async (tx) => {
      await tx.sharedWork.delete({ where: { id } })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: work.authorId,
        action: 'work_delete',
        note: `管理员删除了作品「${work.title}」（status=${work.status}，浏览 ${work.viewCount}/点赞 ${work.likeCount}）`,
      })
    })
    return success(null, '删除成功')
  }
)
