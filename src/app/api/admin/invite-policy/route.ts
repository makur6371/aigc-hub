import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { clearInvitePolicyCache, getInvitePolicy } from '@/lib/invite/policy'

// GET /api/admin/invite-policy - 读取邀请返利策略
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  return success(await getInvitePolicy())
})

// PUT /api/admin/invite-policy - 保存邀请返利策略
export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json() as {
    enabled?: boolean; rewardPercent?: number; requiredUsagePercent?: number; minPaidCents?: number
  }

  const rewardPercent = Math.floor(Number(body.rewardPercent))
  const requiredUsagePercent = Math.floor(Number(body.requiredUsagePercent))
  const minPaidCents = Math.floor(Number(body.minPaidCents))

  if (!Number.isFinite(rewardPercent) || rewardPercent < 0 || rewardPercent > 100) {
    throw new ApiHandlerError('返利比例需在 0-100 之间', 400)
  }
  if (!Number.isFinite(requiredUsagePercent) || requiredUsagePercent < 0 || requiredUsagePercent > 100) {
    throw new ApiHandlerError('达标使用比例需在 0-100 之间', 400)
  }
  if (!Number.isFinite(minPaidCents) || minPaidCents < 0) {
    throw new ApiHandlerError('最低充值门槛不能为负', 400)
  }

  const prisma = await getPrisma()
  const policy = await prisma.invitePolicy.upsert({
    where: { id: 'primary' },
    update: {
      enabled: body.enabled !== false,
      rewardPercent,
      requiredUsagePercent,
      minPaidCents,
    },
    create: {
      id: 'primary',
      enabled: body.enabled !== false,
      rewardPercent,
      requiredUsagePercent,
      minPaidCents,
    },
  })

  clearInvitePolicyCache()
  return success(policy, '已保存')
})
