// 运行工具：run_workflow（同步等待完成）/ get_run / cancel_run。
// 共享执行器 src/lib/mcp/executor.ts（与 /api/canvas/execute 同一套计费/拓扑/执行链路）。

import { getPrisma } from '@/lib/prisma'
import { runCanvasGraph, RunGraphError } from '../executor'
import { sanitizeForAgent, checkWorkflowSize } from '../sanitize'
import type { ToolResult } from './types'
import { ORG } from '@/lib/site-content'

export async function runWorkflow(
  userId: string,
  args: {
    nodes: unknown[]
    connections: unknown[]
    workflowName?: string
    executeNodeIds?: string[]
    seedOutputs?: Record<string, Record<string, unknown>>
  }
): Promise<ToolResult> {
  const sizeError = checkWorkflowSize(args.nodes, args.connections)
  if (sizeError) {
    return { content: [{ type: 'text', text: `无法运行：${sizeError}` }], isError: true }
  }

  try {
    const startedAt = Date.now()
    const result = await runCanvasGraph({
      userId,
      nodes: args.nodes as never[],
      connections: args.connections as never[],
      seedOutputs: args.seedOutputs,
      executeNodeIds: args.executeNodeIds,
      workflowName: args.workflowName,
    })
    const durationSec = Math.round((Date.now() - startedAt) / 1000)

    if (result.status === 'SUCCEEDED') {
      const structured = {
        runId: result.runId,
        status: result.status,
        durationSec,
        costPoints: result.costPoints,
        outputs: sanitizeForAgent(result.outputs),
      }
      return {
        content: [{
          type: 'text',
          text: `运行成功（${durationSec}s，消耗 ${result.costPoints} 积分）。outputs 里是各节点的输出，图片节点看 imageUrl 字段`,
        }],
        structuredContent: structured,
      }
    }
    if (result.status === 'FAILED') {
      return {
        content: [{
          type: 'text',
          text: `运行失败（${durationSec}s，已消耗 ${result.costPoints} 积分）：${result.error ?? '未知错误'}。失败节点已自动退还未消耗积分，可修正后重试`,
        }],
        structuredContent: { runId: result.runId, status: 'FAILED', error: result.error },
      }
    }
    // CANCELLED / PAUSED
    return {
      content: [{ type: 'text', text: `运行已${result.status === 'CANCELLED' ? '取消' : '暂停'}（runId: ${result.runId}）` }],
      structuredContent: { runId: result.runId, status: result.status },
    }
  } catch (err) {
    if (err instanceof RunGraphError) {
      const map: Record<string, string> = {
        INSUFFICIENT_POINTS: `积分不足，请到${ORG.name}个人中心充值后重试`,
        INSUFFICIENT_BEANS: '豆不足（视频节点专用额度），请到个人中心充值',
        CANCELLED: '该 run 已被取消',
        NOT_FOUND: '账号不存在',
      }
      return { content: [{ type: 'text', text: map[err.code] ?? err.message }], isError: true }
    }
    return { content: [{ type: 'text', text: `运行异常：${err instanceof Error ? err.message : '未知错误'}` }], isError: true }
  }
}

export async function getRun(userId: string, args: { runId: string }): Promise<ToolResult> {
  const prisma = await getPrisma()
  const run = await prisma.canvasRun.findFirst({
    where: { id: args.runId, userId },
    select: { id: true, status: true, workflowName: true, error: true, costPoints: true, costBeans: true, seedOutputs: true, createdAt: true, updatedAt: true },
  })
  if (!run) {
    return { content: [{ type: 'text', text: `运行记录 ${args.runId} 不存在或不属于你` }], isError: true }
  }
  const structured = {
    runId: run.id,
    status: run.status,
    workflowName: run.workflowName,
    error: run.error,
    costPoints: run.costPoints,
    costBeans: run.costBeans,
    // 成功时最终输出写进 seedOutputs
    outputs: sanitizeForAgent(run.seedOutputs),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  }
  return {
    content: [{ type: 'text', text: `运行 ${run.id}：${run.status}${run.error ? `（${run.error}）` : ''}` }],
    structuredContent: structured,
  }
}

export async function cancelRun(userId: string, args: { runId: string }): Promise<ToolResult> {
  const prisma = await getPrisma()
  const run = await prisma.canvasRun.findFirst({ where: { id: args.runId, userId } })
  if (!run) {
    return { content: [{ type: 'text', text: `运行记录 ${args.runId} 不存在或不属于你` }], isError: true }
  }
  if (run.status !== 'RUNNING' && run.status !== 'PAUSED') {
    return { content: [{ type: 'text', text: `运行 ${args.runId} 当前状态是 ${run.status}，无需取消` }] }
  }
  await prisma.canvasRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } })
  return {
    content: [{ type: 'text', text: `已发出取消指令，执行器会在下一个节点边界停止并退还未消耗积分` }],
    structuredContent: { runId: run.id, status: 'CANCELLED' },
  }
}
