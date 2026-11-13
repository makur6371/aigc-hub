import { describe, expect, it, vi } from 'vitest'
import { loadLedgerRunInfo } from '@/lib/billing/ledger-enrich'

/**
 * 流水富化（Q-B01）：用户要的是「这笔在哪用的、用了什么模型」。
 * 关键点：一次画布运行会用多个模型，成功与失败尝试都记在调用日志里 ——
 * 只列失败尝试会把用户没拿到的模型显示成「你用了它」。
 */
function fakePrisma(rows: {
  usage: Array<{ runId: string | null; statusCode: number | null; model?: { name: string } | null }>
  canvas?: Array<{ id: string; workflowName: string }>
  tasks?: Array<{ id: string }>
}) {
  return {
    apiUsageLog: { findMany: vi.fn().mockResolvedValue(rows.usage) },
    canvasRun: { findMany: vi.fn().mockResolvedValue(rows.canvas ?? []) },
    generationTask: { findMany: vi.fn().mockResolvedValue(rows.tasks ?? []) },
  }
}

describe('loadLedgerRunInfo', () => {
  it('成功调用优先；全是失败时才退回失败记录里的模型', async () => {
    const p = fakePrisma({
      usage: [
        { runId: 'r1', statusCode: 500, model: { name: '坏模型' } },
        { runId: 'r1', statusCode: 200, model: { name: '好模型' } },
        { runId: 'r2', statusCode: 502, model: { name: '仅失败' } },
      ],
    })
    const map = await loadLedgerRunInfo(p as never, ['r1', 'r2'])
    expect(map.get('r1')!.models).toEqual(['好模型'])
    expect(map.get('r2')!.models).toEqual(['仅失败'])
  })

  it('模型名去重（一次跑 6 张同一个模型不该列 6 遍）', async () => {
    const p = fakePrisma({
      usage: [
        { runId: 'r1', statusCode: 200, model: { name: 'A' } },
        { runId: 'r1', statusCode: 200, model: { name: 'A' } },
        { runId: 'r1', statusCode: 200, model: { name: 'B' } },
      ],
    })
    const map = await loadLedgerRunInfo(p as never, ['r1'])
    expect(map.get('r1')!.models).toEqual(['A', 'B'])
  })

  it('画布 run 给工作流名，Agent 任务给编号，两者都没有则为 null', async () => {
    const p = fakePrisma({
      usage: [],
      canvas: [{ id: 'c1', workflowName: '电商主图流水线' }],
      tasks: [{ id: 't1' }],
    })
    const map = await loadLedgerRunInfo(p as never, ['c1', 't1', 'zzz'])
    expect(map.get('c1')!.taskLabel).toContain('电商主图流水线')
    expect(map.get('t1')!.taskLabel).toMatch(/^Agent 任务 · #/)
    expect(map.get('zzz')!.taskLabel).toBeNull()
  })

  it('空 runId / 全 null 输入不查库（历史数据不该触发无谓查询）', async () => {
    const p = fakePrisma({ usage: [] })
    const map = await loadLedgerRunInfo(p as never, [null, undefined, ''])
    expect(map.size).toBe(0)
    expect(p.apiUsageLog.findMany).not.toHaveBeenCalled()
  })

  it('关联数量有上限（异常入参不把一页查询放大成扫描）', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `r${i}`)
    const p = fakePrisma({ usage: [] })
    await loadLedgerRunInfo(p as never, ids)
    const arg = p.apiUsageLog.findMany.mock.calls[0][0] as { where: { runId: { in: string[] } } }
    expect(arg.where.runId.in.length).toBe(100)
  })
})
