import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { cardKeyListWhere } from '@/lib/card-key-list'

const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: 'file::memory:' }) })
const now = new Date('2026-11-09T12:00:00Z')

beforeAll(async () => {
  await prisma.$executeRawUnsafe('CREATE TABLE users (id TEXT PRIMARY KEY, nickname TEXT, phone TEXT)')
  await prisma.$executeRawUnsafe("INSERT INTO users (id, nickname, phone) VALUES ('buyer', 'Test Buyer', ('188' || '00000000'))")
  await prisma.$executeRawUnsafe('CREATE TABLE card_keys (id TEXT PRIMARY KEY, code TEXT, type TEXT, status TEXT, expiresAt DATETIME, usedByUserId TEXT)')
  await prisma.$executeRawUnsafe("INSERT INTO card_keys VALUES ('a', 'POINTS-A', 'POINTS_PACKAGE', 'UNUSED', '2026-11-08T12:00:00.000Z', NULL), ('b', 'POINTS-B', 'POINTS_PACKAGE', 'UNUSED', '2026-11-10T12:00:00.000Z', NULL), ('c', 'BEANS-C', 'BEANS_PACKAGE', 'USED', NULL, 'buyer'), ('d', 'SUB-D', 'SUBSCRIPTION', 'UNUSED', NULL, NULL), ('e', 'POINTS-E', 'POINTS_PACKAGE', 'EXPIRED', NULL, NULL)")
})

afterAll(() => prisma.$disconnect())

async function matching(query: string) {
  const rows = await prisma.cardKey.findMany({ where: cardKeyListWhere(new URLSearchParams(query), now), select: { code: true }, orderBy: { code: 'asc' } })
  return rows.map((row) => row.code)
}

describe('卡密筛选（SQLite）', () => {
  it('到期但未落库标记的卡密也归入已过期，未使用不包含它', async () => {
    expect(await matching('status=EXPIRED')).toEqual(['POINTS-A', 'POINTS-E'])
    expect(await matching('status=UNUSED')).toEqual(['POINTS-B', 'SUB-D'])
  })

  it('类型、状态和关键词同时生效，关键词的 OR 不覆盖过期条件', async () => {
    expect(await matching('status=UNUSED&type=POINTS_PACKAGE&keyword=POINTS')).toEqual(['POINTS-B'])
    expect(await matching('status=UNUSED&keyword=POINTS-A')).toEqual([])
  })

  it('支持按兑换人查询，并忽略无效枚举筛选', async () => {
    expect(await matching('keyword=188' + '00000000')).toEqual(['BEANS-C'])
    expect(await matching('keyword=Buyer')).toEqual(['BEANS-C'])
    expect(await matching('status=INVALID&type=INVALID')).toHaveLength(5)
  })
})
