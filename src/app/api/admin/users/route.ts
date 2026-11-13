import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'

export const GET = apiHandler(async (request: NextRequest) => {
  const _user = await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const keyword = url.searchParams.get('keyword')?.trim() || undefined
  const status = url.searchParams.get('status') || undefined
  const securityLevel = url.searchParams.get('securityLevel') || undefined

  const where: Prisma.UserWhereInput = {}
  if (status && ['NORMAL', 'FROZEN'].includes(status)) {
    where.status = status as 'NORMAL' | 'FROZEN'
  }
  if (securityLevel && ['LOW', 'HIGH'].includes(securityLevel)) {
    where.securityLevel = securityLevel as 'LOW' | 'HIGH'
  }
  if (keyword) {
    where.OR = [
      { phone: { contains: keyword } },
      { email: { contains: keyword } },
      { nickname: { contains: keyword } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        phone: true,
        email: true,
        nickname: true,
        role: true,
        status: true,
        securityLevel: true,
        securityVerifiedAt: true,
        emailVerified: true,
        adminVerified: true,
        points: true,
        beans: true,
        billingType: true,
        subscriptionExpiryAt: true,
        freeImageUntil: true,
        socialUid: true,
        socialProvider: true,
        passwordHash: true, // 仅用于推算 hasPassword，不直接返回
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.user.count({ where }),
  ])

  return {
    items: items.map((u) => {
      // 剥离 passwordHash，只回 hasPassword 标志位（避免泄露哈希本身）
      const { passwordHash, ...rest } = u
      // 「半成品账号」标记：无手机号 + 无密码。
      // 这类账号是旧版「微信登录自动建号」的产物，会占住 OpenID 导致用户绑不上微信。
      // 新代码已能在用户绑微信时自动回收它们（见 /api/user/wx/bind），
      // 这里标出来是为了让管理员能一眼看到还有哪些历史残留待处理。
      const isHalfBaked = !u.phone && passwordHash === ''
      return {
        ...rest,
        hasPassword: passwordHash !== '',
        isHalfBaked,
        subscriptionExpiryAt: u.subscriptionExpiryAt?.toISOString() ?? null,
        freeImageUntil: u.freeImageUntil?.toISOString() ?? null,
        securityVerifiedAt: u.securityVerifiedAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      }
    }),
    total,
    page,
    pageSize,
  }
})
