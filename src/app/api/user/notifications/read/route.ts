import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'

/**
 * 标记通知已读：
 *   body { id }   → 标记单条
 *   body { all: true } → 全部标记（点开铃铛面板即调，符合直觉）
 * where 一律带 userId，防止越权改别人的已读状态。
 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; all?: unknown }

  if (body.all === true) {
    const res = await prisma.userNotification.updateMany({
      where: { userId: authUser.userId, readAt: null },
      data: { readAt: new Date() },
    })
    return success({ updated: res.count }, '已全部标记已读')
  }

  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return success({ updated: 0 }, '缺少通知 id')
  const res = await prisma.userNotification.updateMany({
    where: { id, userId: authUser.userId },
    data: { readAt: new Date() },
  })
  return success({ updated: res.count }, '已标记已读')
})
