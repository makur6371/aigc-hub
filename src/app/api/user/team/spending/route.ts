import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, parsePagination } from '@/lib/api-handler'
import { getTeamSpending } from '@/lib/billing/team-spending'

/**
 * 团队成员消费明细（老板视角）。只读聚合，聚合逻辑在 lib/billing/team-spending.ts。
 *
 * 为什么不复用个人账本接口加过滤参数：见 team-spending.ts 的口径说明 ——
 * 「我出的钱」与「我花的钱」是两个查询口径，混排会分不清谁花的。
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  const url = new URL(request.url)
  const me = authUser.userId
  const memberId = url.searchParams.get('memberId')?.trim() || null
  const { page, pageSize } = parsePagination(url, { pageSize: 20, maxPageSize: 50 })

  const team = await prisma.team.findUnique({ where: { ownerId: me }, select: { id: true, name: true, status: true } })
  if (!team) throw new ApiHandlerError('你不是企业团队管理员', 403)

  const spending = await getTeamSpending(me, { memberId, page, pageSize })
  return { team: { id: team.id, name: team.name, status: team.status }, ...spending, page, pageSize }
})
