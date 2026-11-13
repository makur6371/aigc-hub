import type { Prisma } from '@prisma/client'
import { CARD_KEY_TYPES } from './card-key'

export function cardKeyListWhere(params: URLSearchParams, now: Date = new Date()): Prisma.CardKeyWhereInput {
  const filters: Prisma.CardKeyWhereInput[] = []
  const type = params.get('type')
  const status = params.get('status')
  const keyword = params.get('keyword')?.trim().slice(0, 100)
  if (type && CARD_KEY_TYPES.includes(type as typeof CARD_KEY_TYPES[number])) filters.push({ type: type as typeof CARD_KEY_TYPES[number] })
  if (status === 'USED') filters.push({ status: 'USED' })
  if (status === 'UNUSED') filters.push({ status: 'UNUSED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] })
  if (status === 'EXPIRED') filters.push({ OR: [{ status: 'EXPIRED' }, { status: 'UNUSED', expiresAt: { lte: now } }] })
  if (keyword) filters.push({ OR: [{ code: { contains: keyword } }, { usedBy: { is: { nickname: { contains: keyword } } } }, { usedBy: { is: { phone: { contains: keyword } } } }] })
  return filters.length ? { AND: filters } : {}
}
