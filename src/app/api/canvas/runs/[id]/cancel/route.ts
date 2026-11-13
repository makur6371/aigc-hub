import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

// 取消画布执行（execute 路由会在节点间检查到 CANCELLED 并退款停止）
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const run = await prisma.canvasRun.findFirst({ where: { id, userId: authUser.userId } })
    if (!run) {
      throw new ApiHandlerError('执行任务不存在', 404)
    }

    const updated = await prisma.canvasRun.update({ where: { id }, data: { status: 'CANCELLED' } })
    return success({ id, status: updated.status }, '已取消')
  }
)
