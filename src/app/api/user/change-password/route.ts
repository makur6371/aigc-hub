import { NextRequest, NextResponse } from 'next/server'
import { sessionCookieOptions, signSessionToken } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'
import { isPasswordValid, PASSWORD_MIN_LENGTH } from '@/lib/password-policy'
import bcrypt from 'bcryptjs'

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  // 改密码尝错限流：userId + IP 双限流，5 次/h 锁定，防暴力试原密码
  const ip = getClientIp(request)
  if (!checkRateLimit(`change-pwd:ip:${ip}`, { windowMs: 60 * 60 * 1000, maxRequests: 5 }).allowed) {
    throw new ApiHandlerError('尝试过于频繁，请 1 小时后再试', 429)
  }
  if (!checkRateLimit(`change-pwd:user:${authUser.userId}`, { windowMs: 60 * 60 * 1000, maxRequests: 5 }).allowed) {
    throw new ApiHandlerError('尝试过于频繁，请 1 小时后再试', 429)
  }

  const body = await request.json().catch(() => null)
  const oldPassword = body?.oldPassword
  const newPassword = body?.newPassword
  if (!isPasswordValid(newPassword)) {
    throw new ApiHandlerError(`新密码长度至少${PASSWORD_MIN_LENGTH}位`, 400)
  }
  if (oldPassword !== undefined && typeof oldPassword !== 'string') {
    throw new ApiHandlerError('请求参数无效', 400)
  }

  const prisma = await getPrisma()
  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: { passwordHash: true, status: true },
  })

  if (!user) {
    throw new ApiHandlerError('用户不存在', 404)
  }
  if (user.status === 'FROZEN') {
    throw new ApiHandlerError('账号已被冻结', 403)
  }

  // 未设置过密码的账号首次设置密码时，不需要原密码
  if (user.passwordHash === '') {
    if (oldPassword) {
      throw new ApiHandlerError('当前账号尚未设置密码，请直接设置新密码', 400)
    }
  } else {
    if (!oldPassword) {
      throw new ApiHandlerError('请填写原密码和新密码', 400)
    }
    const valid = await bcrypt.compare(oldPassword, user.passwordHash)
    if (!valid) {
      throw new ApiHandlerError('原密码错误', 400)
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  // 递增会话版本：改密通常正是因为「账号被人拿到了」，不递增则旧 token 还能用到 7 天到期（Q-506）。
  const updated = await prisma.user.update({
    where: { id: authUser.userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
    select: { id: true, phone: true, role: true, tokenVersion: true },
  })

  // 同时给**当前**会话换发新 token：前端改完密码是留在页面上的
  // （SecuritySettingsContent 不跳登录），只递增不换发等于把自己也踢下线。
  const res = NextResponse.json({ success: true, data: null, message: '密码已修改' })
  res.cookies.set('token', signSessionToken(updated), sessionCookieOptions())
  return res
})
