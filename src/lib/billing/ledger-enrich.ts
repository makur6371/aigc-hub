import type { PrismaClient } from '@prisma/client'

/**
 * 流水「用了哪个模型 / 哪个任务」批量富化（台账 Q-B01）。
 *
 * 用户原话：「积分记录里看不到是在哪用的、用的什么模型」——
 * 以前模型名只混在 description 文案里，不可结构化筛选，画布/批量场景更是看不全。
 *
 * 为什么单独成模块：points / beans 两条用户端路由 + 两条后台路由**共 4 处**
 * 都在写同一套「分页 + 出资人名字」逻辑，任何一处加字段都会漏掉其它三处。
 * 这里只负责「按 runId 反查模型与任务名」这一件事，各处按需调用。
 *
 * 依赖：`chargeRun` 保证每笔扣费都有事务号（2026-11-01 起兜底生成），
 * 所以新数据一定能关联；历史数据 runId 为空时安静降级为「无模型信息」。
 */

export type LedgerRunInfo = {
  /** 该次执行实际用过的模型名（成功调用优先；失败尝试只在没有成功记录时才展示） */
  models: string[]
  /** 任务名：画布取工作流名，Agent 取「Agent 任务 · #尾号」 */
  taskLabel: string | null
}

/** 关联上限：一页最多 50 条流水，这里再收一道，避免异常入参把查询放大 */
const MAX_RUN_IDS = 100

export async function loadLedgerRunInfo(
  prisma: PrismaClient,
  runIds: Array<string | null | undefined>,
): Promise<Map<string, LedgerRunInfo>> {
  const ids = Array.from(new Set(runIds.filter((v): v is string => typeof v === 'string' && v.length > 0))).slice(0, MAX_RUN_IDS)
  const out = new Map<string, LedgerRunInfo>()
  if (ids.length === 0) return out

  // 一次批量查三张表：调用日志（模型）、画布 run（工作流名）、Agent 任务（是否存在）
  const [usageRows, canvasRows, taskRows] = await Promise.all([
    prisma.apiUsageLog.findMany({
      where: { runId: { in: ids } },
      select: { runId: true, statusCode: true, model: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.canvasRun.findMany({
      where: { id: { in: ids } },
      select: { id: true, workflowName: true },
    }),
    prisma.generationTask.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    }),
  ])

  // 先按 runId 分两组模型名：成功的（2xx）优先，全失败时才退回失败记录
  const okNames = new Map<string, string[]>()
  const anyNames = new Map<string, string[]>()
  for (const row of usageRows) {
    const rid = row.runId
    const name = row.model?.name
    if (!rid || !name) continue
    const any = anyNames.get(rid) ?? []
    if (!any.includes(name)) any.push(name)
    anyNames.set(rid, any)
    if (row.statusCode != null && row.statusCode >= 200 && row.statusCode < 300) {
      const ok = okNames.get(rid) ?? []
      if (!ok.includes(name)) ok.push(name)
      okNames.set(rid, ok)
    }
  }

  const canvasName = new Map(canvasRows.map((c) => [c.id, c.workflowName]))
  const taskIds = new Set(taskRows.map((t) => t.id))

  for (const id of ids) {
    const models = okNames.get(id) ?? anyNames.get(id) ?? []
    const wf = canvasName.get(id)
    const taskLabel = wf ? `画布 · ${wf}` : taskIds.has(id) ? `Agent 任务 · #${id.slice(-6)}` : null
    out.set(id, { models, taskLabel })
  }
  return out
}
