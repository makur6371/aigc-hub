import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import { ledgerPayer } from '@/lib/billing/team'
import { loadLedgerRunInfo } from '@/lib/billing/ledger-enrich'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = await requireAuth(request)
  const prisma = await getPrisma()
  const { page, pageSize } = parsePagination(new URL(request.url), { maxPageSize: 50 })

  // 同积分记录：只展示真实动过余额的流水，隐藏节点级内部记账（category='canvas-node'），
  // 否则「预扣 + 节点分摊」并列显示会被误读成扣了两次。
  // 归属两视角（我花的 / 我出的钱）都要列出，否则老板的豆账本对不平团队消费。
  const where = { category: null, OR: [{ userId: user.userId }, { billingOwnerId: user.userId }] }
  const [items, total] = await Promise.all([
    prisma.beansLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { id: true, nickname: true, phone: true } } },
    }),
    prisma.beansLog.count({ where }),
  ])

  const teamOwnerIds = Array.from(new Set(items.map((l) => l.billingOwnerId).filter((v): v is string => !!v)))
  const owners = teamOwnerIds.length
    ? await prisma.user.findMany({ where: { id: { in: teamOwnerIds } }, select: { id: true, nickname: true, phone: true } })
    : []
  const ownerName = new Map(owners.map((o) => [o.id, o.nickname || o.phone || '企业账号']))

  // 与积分流水同一套富化实现（Q-B01）：豆记录要能看到是哪个视频模型
  const runInfo = await loadLedgerRunInfo(prisma, items.map((l) => l.runId))

  return {
    items: items.map((log) => {
      const payer = ledgerPayer(log.billingOwnerId, user.userId, log.billingOwnerId ? ownerName.get(log.billingOwnerId) : null)
      const info = log.runId ? runInfo.get(log.runId) : undefined
      return {
        id: log.id,
        amount: log.amount,
        type: log.type,
        description: log.description,
        createdAt: log.createdAt.toISOString(),
        runId: log.runId ?? null,
        modelNames: info?.models ?? [],
        taskLabel: info?.taskLabel ?? null,
        spenderName: log.userId === user.userId ? null : (log.user.nickname || log.user.phone || '成员'),
        ...payer,
      }
    }),
    total,
    page,
    pageSize,
  }
})
