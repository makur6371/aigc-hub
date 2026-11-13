import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { getPrisma } from '@/lib/prisma'
import {
  FREE_IMAGE_DAY_MINUTES,
  nextFreeImageUntil,
} from './free-image'

type Tx = Prisma.TransactionClient
type GrantSource = 'WELCOME' | 'SUBSCRIPTION' | 'CHECKIN' | 'INVITE' | 'ADMIN'

interface GrantInput {
  userId: string
  source: GrantSource
  sourceKey: string
  minutes: number
  description: string
  /** 管理员代发时记录操作人；自助领取不传 */
  operatorId?: string | null
  now?: Date
  tx?: Tx
}

export async function grantFreeImageTime(input: GrantInput) {
  const now = input.now ?? new Date()
  if (!Number.isSafeInteger(input.minutes)) throw new Error('生图时长需为整数分钟')
  nextFreeImageUntil(null, input.minutes / FREE_IMAGE_DAY_MINUTES, now)
  if (!input.sourceKey.trim()) throw new Error('缺少生图时长发放凭证')

  const run = async (tx: Tx) => {
    const grantId = randomUUID()
    const inserted = await tx.$executeRaw`
      INSERT INTO free_image_grants
        (id, user_id, source, source_key, minutes, description, starts_at, expires_at, operator_id, created_at)
      VALUES (${grantId}, ${input.userId}, ${input.source}, ${input.sourceKey},
        ${input.minutes}, ${input.description}, ${now}, ${now}, ${input.operatorId ?? null}, ${now})
      ON CONFLICT(user_id, source, source_key) DO NOTHING
    `
    if (inserted === 0) {
      const grant = await tx.freeImageGrant.findUniqueOrThrow({
        where: { userId_source_sourceKey: { userId: input.userId, source: input.source, sourceKey: input.sourceKey } },
      })
      return { granted: false, grant }
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { freeImageUntil: true, status: true },
    })
    if (input.source === 'WELCOME' && user.status !== 'NORMAL') throw new Error('账号状态异常，无法领取生图时长')
    const startsAt = user.freeImageUntil && user.freeImageUntil > now ? user.freeImageUntil : now
    const expiresAt = nextFreeImageUntil(user.freeImageUntil, input.minutes / FREE_IMAGE_DAY_MINUTES, now)
    await tx.user.update({ where: { id: input.userId }, data: { freeImageUntil: expiresAt }, select: { id: true } })
    const grant = await tx.freeImageGrant.update({ where: { id: grantId }, data: { startsAt, expiresAt } })
    return { granted: true, grant }
  }

  if (input.tx) return run(input.tx)
  const prisma = await getPrisma()
  return prisma.$transaction(run)
}
