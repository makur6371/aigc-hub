import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination } from '@/lib/api-handler'
import { ledgerPayer } from '@/lib/billing/team'
import { loadLedgerRunInfo } from '@/lib/billing/ledger-enrich'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = await requireAuth(request)
  const prisma = await getPrisma()
  const { page, pageSize } = parsePagination(new URL(request.url), { maxPageSize: 50 })

  // 只展示「真实动过余额」的流水（category=null）。
  // 画布/工具的节点级记账（category='canvas-node'）是预算池内部的分摊记录，
  // 余额只在「预扣」时动过一次；把它一并列出来会让用户以为扣了两次。
  //
  // 归属两视角都要看：
  //   - userId=我         → 我花的（我自己 + 团队成员花我的）
  //   - billingOwnerId=我  → 我出的钱（团队消费记在成员名下，但账单是我的）
  // 二者用 OR 合并，老板的账本就与钱包净变动可对平（缺了 billingOwnerId 会少列团队消费）。
  const where = { category: null, OR: [{ userId: user.userId }, { billingOwnerId: user.userId }] }
  const [items, total] = await Promise.all([
    prisma.pointsLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // 需要知道出钱人是谁（成员名），只能 join 一次
      include: { user: { select: { id: true, nickname: true, phone: true } } },
    }),
    prisma.pointsLog.count({ where }),
  ])

  // 团队成员消费是本团队老板出的钱：一次性查出老板名，避免逐行再查
  const teamOwnerIds = Array.from(new Set(items.map((l) => l.billingOwnerId).filter((v): v is string => !!v)))
  const owners = teamOwnerIds.length
    ? await prisma.user.findMany({ where: { id: { in: teamOwnerIds } }, select: { id: true, nickname: true, phone: true } })
    : []
  const ownerName = new Map(owners.map((o) => [o.id, o.nickname || o.phone || '企业账号']))

  // 「用的什么模型 / 哪个任务」：按事务号批量反查（Q-B01），一次查完不给每行发 SQL
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
        // 谁花的：userId 是成员时（老板视角）要显示成员名，而不是「我」
        spenderName: log.userId === user.userId ? null : (log.user.nickname || log.user.phone || '成员'),
        ...payer,
      }
    }),
    total,
    page,
    pageSize,
  }
})
