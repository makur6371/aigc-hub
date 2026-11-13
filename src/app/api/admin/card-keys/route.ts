import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination, ApiHandlerError } from '@/lib/api-handler'
import { generateCardKeyCode, parseCardKeyBatchInput } from '@/lib/card-key'
import { cardKeyListWhere } from '@/lib/card-key-list'

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
  const now = new Date()
  const where = cardKeyListWhere(url.searchParams, now)

  const [items, total] = await Promise.all([
    prisma.cardKey.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { usedBy: { select: { nickname: true, phone: true } } },
    }),
    prisma.cardKey.count({ where }),
  ])

  return {
    items: items.map((k) => ({
      ...k,
      status: k.status === 'UNUSED' && k.expiresAt && k.expiresAt <= now ? 'EXPIRED' : k.status,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt?.toISOString() ?? null,
      usedAt: k.usedAt?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
  }
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const parsed = parseCardKeyBatchInput(await request.json())
  if (!parsed.ok) throw new ApiHandlerError(parsed.error, 400)
  const { type, pointsValue, beansValue, durationDays, freeImageDays, count, expiresAt } = parsed.data
  const prisma = await getPrisma()
  const codes: string[] = []

  for (let i = 0; i < count; i++) {
    codes.push(generateCardKeyCode())
  }

  const existing = await prisma.cardKey.findMany({
    where: { code: { in: codes } },
    select: { code: true },
  })
  const existingSet = new Set(existing.map((e) => e.code))

  const createData = codes.map((code) => {
    let finalCode = code
    while (existingSet.has(finalCode)) {
      finalCode = generateCardKeyCode()
    }
    existingSet.add(finalCode)

    return {
      code: finalCode,
      type,
      // 订阅卡密可带 pointsValue/beansValue：激活订阅时作为订阅赠送一次性发放（与在线充值订阅套餐对齐）
      pointsValue,
      beansValue,
      durationDays,
      freeImageDays,
      expiresAt,
    }
  })

  await prisma.cardKey.createMany({ data: createData })

  return {
    codes: createData.map((d) => d.code),
    count: createData.length,
  }
})
