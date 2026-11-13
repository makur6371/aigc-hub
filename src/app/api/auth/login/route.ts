import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { apiHandler, ApiHandlerError } from '@/lib/api-handler'
import { sessionCookieOptions, signSessionToken } from '@/lib/auth'
import { checkSubscriptionExpiry } from '@/lib/billing/wallet'
import { getClientIp } from '@/lib/rate-limit'
import { clearAuthFailures, peekAuthRateLimit, recordAuthFailure } from '@/lib/auth-rate-limit'

// 账号格式识别：手机号或邮箱二选一
const isPhone = (v: string) => /^1[3-9]\d{9}$/.test(v)
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

export const POST = apiHandler(async (request: NextRequest) => {
  const prisma = await getPrisma()
  const body = await request.json()
  // 兼容字段名 account；旧调用方传 phone 也能用（便于平滑迁移）
  const account: string = (body.account || body.phone || '').trim()
  const { password } = body

  if (!account || !password) {
    throw new ApiHandlerError('账号和密码不能为空', 400)
  }

  // 登录尝错限流：IP + 账号双限流，5 次/15min，防暴力破解（计划 3.3 / Q-D21）。
  // 改为**持久化 + 只计失败**：内存版重启即清零（发版窗口可被绕过），
  // 且旧实现连成功登录也计数，正常用户输错几次就把自己锁在门外。
  const ip = getClientIp(request)
  const LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, maxRequests: 5 }
  const ipLimit = await peekAuthRateLimit(ip, 'login:ip', LOGIN_LIMIT)
  if (!ipLimit.allowed) {
    throw new ApiHandlerError('登录尝试过于频繁，请 15 分钟后再试', 429)
  }
  const acctLimit = await peekAuthRateLimit(account, 'login:account', LOGIN_LIMIT)
  if (!acctLimit.allowed) {
    throw new ApiHandlerError('该账号登录尝试过于频繁，请 15 分钟后再试', 429)
  }

  // 按格式判断查询字段：手机号 → phone；邮箱 → email；都不是 → 直接走错误文案（防探测）
  let user
  if (isPhone(account)) {
    user = await prisma.user.findUnique({ where: { phone: account } })
  } else if (isEmail(account)) {
    user = await prisma.user.findUnique({ where: { email: account.toLowerCase() } })
  }
  // 用户枚举防护：用户不存在、格式非法、密码错误统一文案
  if (!user) {
    // 不区分「用户不存在」与「密码错误」，但两者都计失败次数（爆破必走其中之一）
    await recordAuthFailure(ip, 'login:ip', LOGIN_LIMIT)
    await recordAuthFailure(account, 'login:account', LOGIN_LIMIT)
    throw new ApiHandlerError('账号或密码错误', 401)
  }

  if (user.status === 'FROZEN') {
    throw new ApiHandlerError('账号已被冻结', 403)
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  // 统一文案，防用户枚举
  if (!valid) {
    await recordAuthFailure(ip, 'login:ip', LOGIN_LIMIT)
    await recordAuthFailure(account, 'login:account', LOGIN_LIMIT)
    throw new ApiHandlerError('账号或密码错误', 401)
  }

  // 登录成功：清空本窗口失败计数（先前的打字错误不留尾账）
  await clearAuthFailures(ip, 'login:ip', LOGIN_LIMIT.windowMs)
  await clearAuthFailures(account, 'login:account', LOGIN_LIMIT.windowMs)

  // 惰性订阅到期检查：登录时回滚过期订阅（积分保留），前端拿到的是回滚后的真实状态
  if (user.billingType === 'SUBSCRIPTION') {
    const expired = await checkSubscriptionExpiry(user.id)
    if (expired) user.billingType = 'POINTS'
  }

  // 统一走 signSessionToken：把 tokenVersion 签进去，改密/重置后旧会话才作废得了（Q-506）
  const token = signSessionToken(user)

  const response = NextResponse.json({
    success: true,
    data: {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        status: user.status,
        securityLevel: user.securityLevel,
        emailVerified: user.emailVerified,
        adminVerified: user.adminVerified,
        points: user.points,
        billingType: user.billingType,
        subscriptionExpiryAt: user.subscriptionExpiryAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    },
    message: '登录成功',
  })

  response.cookies.set('token', token, {
    ...sessionCookieOptions(),
  })

  return response
})
