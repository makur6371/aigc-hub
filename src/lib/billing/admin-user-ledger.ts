import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, parsePagination } from '@/lib/api-handler'
import { CATEGORY_CANVAS_NODE } from '@/lib/billing/billing-plans'
import { loadLedgerRunInfo } from '@/lib/billing/ledger-enrich'

export type AdminLedgerKind = 'points' | 'beans'
type LedgerScope = 'all' | 'real' | 'node'

/**
 * 管理员单用户账本：积分与视频豆共用同一套对账口径。
 *
 * 用户端只列真实动账（category=null），管理员需要同时看到节点级记账，
 * 否则视频真实消耗、画布分摊和余额差额都看不出来。
 */
export function createAdminUserLedgerRoute(kind: AdminLedgerKind) {
  const label = kind === 'points' ? '积分' : '视频豆'
  return apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params
    const url = new URL(request.url)
    const { page, pageSize } = parsePagination(url, { maxPageSize: 100 })
    const rawScope = url.searchParams.get('scope')
    const scope: LedgerScope = rawScope === 'real' ? 'real' : rawScope === 'node' ? 'node' : 'all'

    const prisma = await getPrisma()
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true, nickname: true, beans: true, points: true, billingOwnerId: true },
    })
    if (!user) throw new ApiHandlerError('用户不存在', 404)

    const where: Record<string, unknown> = { OR: [{ userId: id }, { billingOwnerId: id }] }
    if (scope === 'real') where.category = null
    else if (scope === 'node') where.category = CATEGORY_CANVAS_NODE

    const select = {
      id: true, userId: true, billingOwnerId: true, amount: true, type: true, category: true,
      description: true, createdAt: true, runId: true,
      user: { select: { id: true, nickname: true, phone: true } },
    } as const
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

    const [rows, total, realSum, nodeSum, ownerRows] = await Promise.all([
      kind === 'points'
        ? prisma.pointsLog.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, select })
        : prisma.beansLog.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, select }),
      kind === 'points' ? prisma.pointsLog.count({ where }) : prisma.beansLog.count({ where }),
      kind === 'points'
        ? prisma.pointsLog.aggregate({ where: { category: null, OR: [{ userId: id }, { billingOwnerId: id }] }, _sum: { amount: true } })
        : prisma.beansLog.aggregate({ where: { category: null, OR: [{ userId: id }, { billingOwnerId: id }] }, _sum: { amount: true } }),
      kind === 'points'
        ? prisma.pointsLog.aggregate({ where: { category: CATEGORY_CANVAS_NODE, OR: [{ userId: id }, { billingOwnerId: id }] }, _sum: { amount: true } })
        : prisma.beansLog.aggregate({ where: { category: CATEGORY_CANVAS_NODE, OR: [{ userId: id }, { billingOwnerId: id }] }, _sum: { amount: true } }),
      kind === 'points'
        ? prisma.pointsLog.groupBy({ by: ['type', 'category'], where: { OR: [{ userId: id }, { billingOwnerId: id }] }, _count: { _all: true }, _sum: { amount: true } })
        : prisma.beansLog.groupBy({ by: ['type', 'category'], where: { OR: [{ userId: id }, { billingOwnerId: id }] }, _count: { _all: true }, _sum: { amount: true } }),
    ])

    const ownerIds = Array.from(new Set(rows.map((row) => row.billingOwnerId).filter((value): value is string => !!value)))
    const owners = ownerIds.length
      ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, nickname: true, phone: true } })
      : []
    const ownerName = new Map(owners.map((owner) => [owner.id, owner.nickname || owner.phone || '企业账号']))
    const runInfo = await loadLedgerRunInfo(prisma, rows.map((row) => row.runId))
    const round = (value: number) => Math.round(value * 100) / 100
    const realTotal = round(realSum._sum.amount ?? 0)
    const nodeTotal = round(nodeSum._sum.amount ?? 0)
    const balance = kind === 'points' ? user.points : user.beans

    return {
      kind,
      user,
      summary: {
        /** 账上余额（users.points / users.beans） */
        balance,
        realTotal,
        nodeTotal,
        balanceVsRealGap: round(balance - realTotal),
        byType: ownerRows.map((row) => ({
          type: row.type,
          category: row.category,
          count: row._count._all,
          total: round(row._sum.amount ?? 0),
        })),
      },
      items: rows.map((row) => {
        const info = row.runId ? runInfo.get(row.runId) : undefined
        return {
          id: row.id,
          amount: row.amount,
          type: row.type,
          category: row.category,
          description: row.description,
          createdAt: row.createdAt.toISOString(),
          runId: row.runId,
          modelNames: info?.models ?? [],
          taskLabel: info?.taskLabel ?? null,
          spenderName: row.userId === id ? null : row.user.nickname || row.user.phone || '成员',
          payerName: row.billingOwnerId ? ownerName.get(row.billingOwnerId) ?? null : null,
        }
      }),
      total,
      page,
      pageSize,
      label,
    }
  })
}
