import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { clearPolicyCache } from '@/lib/verification-policy'

export const GET = apiHandler(async () => {
  const prisma = await getPrisma()
  const policy = await prisma.verificationPolicy.findUnique({ where: { id: 'primary' } })
  return policy || { id: 'primary', codeExpiryMinutes: 10, resendCooldownSec: 60 }
})

export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json()
  const { codeExpiryMinutes, resendCooldownSec } = body

  // 必须先把输入转成数字再比较：'abc' < 1 与 'abc' > 60 都是 false，
  // 原实现会让 'abc' 穿过校验，然后 Number('abc')=NaN 写 Int 列 → 500。
  const expiryNum = Number(codeExpiryMinutes)
  if (!Number.isInteger(expiryNum) || expiryNum < 1 || expiryNum > 60) {
    throw new ApiHandlerError('有效时间需在 1-60 分钟的整数', 400)
  }
  const cooldownNum = Number(resendCooldownSec)
  if (!Number.isInteger(cooldownNum) || cooldownNum < 10 || cooldownNum > 600) {
    throw new ApiHandlerError('冷却间隔需在 10-600 秒的整数', 400)
  }

  const prisma = await getPrisma()
  const policy = await prisma.verificationPolicy.upsert({
    where: { id: 'primary' },
    update: { codeExpiryMinutes: expiryNum, resendCooldownSec: cooldownNum },
    create: { id: 'primary', codeExpiryMinutes: expiryNum, resendCooldownSec: cooldownNum },
  })

  clearPolicyCache()
  return policy
})
