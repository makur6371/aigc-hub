import { NextRequest } from 'next/server'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { getPrisma } from '@/lib/prisma'
import { extractAgentResults, extractCanvasResults } from '@/lib/recoverable-media'
import type { RecoverableTask } from '@/lib/result-recovery'

export const GET = apiHandler(async (request: NextRequest) => {
  const { userId } = await requireAuth(request)
  const prisma = await getPrisma()
  const timestamp = Number(new URL(request.url).searchParams.get('before'))
  const before = new Date(Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, Date.now()) : Date.now())
  const orderBy = [{ updatedAt: 'desc' as const }, { id: 'desc' as const }]
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)
  const canvasWhere = { userId, createdAt: { lte: before }, surface: { in: ['tool', 'batch'] }, NOT: { workflowName: { contains: '预处理' } } }
  const agentWhere = { userId, createdAt: { lte: before }, taskType: 'agent' }
  const videoWhere = { userId, runId: { not: null } }
  const canvasSelect = { id: true, status: true, createdAt: true, updatedAt: true, error: true, workflowName: true, nodes: true, resultNodeIds: true, seedOutputs: true }
  const agentSelect = { id: true, status: true, createdAt: true, updatedAt: true, error: true, payload: true }
  const videoSelect = { id: true, status: true, createdAt: true, errorMessage: true, videoUrl: true }
  const [canvasActive, canvasRecent, agentActive, agentRecent, videoActive, videoRecent] = await Promise.all([
    prisma.canvasRun.findMany({ where: { ...canvasWhere, status: { in: ['RUNNING', 'PENDING'] } }, select: canvasSelect, orderBy }),
    prisma.canvasRun.findMany({ where: canvasWhere, select: canvasSelect, orderBy, take: 100 }),
    prisma.generationTask.findMany({ where: { ...agentWhere, status: { in: ['RUNNING', 'PENDING'] } }, select: agentSelect, orderBy }),
    prisma.generationTask.findMany({ where: agentWhere, select: agentSelect, orderBy, take: 100 }),
    prisma.videoGenerationRecord.findMany({ where: { ...videoWhere, status: 'PENDING' }, select: videoSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    prisma.videoGenerationRecord.findMany({ where: videoWhere, select: videoSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
  ])
  const tasks = new Map<string, RecoverableTask>()
  const state = (status: string, updatedAt: Date) =>
    ['RUNNING', 'PENDING'].includes(status) && updatedAt < cutoff ? 'FAILED' : status
  for (const run of [...canvasRecent, ...canvasActive]) {
    const ids = Array.isArray(run.resultNodeIds) ? run.resultNodeIds as string[] : null
    const nodes = Array.isArray(run.nodes) ? run.nodes as Array<{ id: string; type: string; label?: string }> : []
    const results = extractCanvasResults(run.seedOutputs, ids)
    const pendingNodes = nodes.filter((node) => (ids?.length ? ids.includes(node.id) : node.id.startsWith('gen-')) && !results.some((result) => result.nodeId === node.id))
    const status = state(run.status, run.updatedAt)
    tasks.set(run.id, {
      id: run.id, status, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
      toolName: run.workflowName, error: run.error, results,
      pending: pendingNodes.length ? pendingNodes.map((node) => ({
        nodeId: node.id, kind: /video/.test(node.type) ? 'video' : /audio/.test(node.type) ? 'audio' : 'image', label: node.label,
      })) : results.length ? [] : [{ nodeId: run.id, kind: 'image' }],
    })
  }
  for (const task of [...agentRecent, ...agentActive]) {
    const payload = task.payload as { subtasks?: Array<{ id?: string; type?: string; title?: string; status?: string; count?: number; videoPending?: boolean }> } | null
    const subtasks = Array.isArray(payload?.subtasks) ? payload.subtasks : []
    const id = `agent:${task.id}`
    tasks.set(id, {
      id, status: state(task.status, task.updatedAt), createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
      toolName: '智能体', error: task.error, results: extractAgentResults(subtasks),
      pending: subtasks.length ? subtasks.filter((item) => !item.videoPending && item.status !== 'success' && item.status !== 'failed').flatMap((item) =>
        Array.from({ length: Math.min(100, Math.max(1, Number(item.count) || 1)) }, () => ({
          nodeId: item.id || id, kind: item.type === 'video' ? 'video' as const : 'image' as const, label: item.title,
        }))) : [{ nodeId: id, kind: 'image', label: '正在理解需求' }],
    })
  }
  for (const record of [...videoRecent, ...videoActive]) {
    const id = `video:${record.id}`
    tasks.set(id, {
      id, status: record.status === 'SUCCESS' ? 'SUCCEEDED' : record.status,
      createdAt: record.createdAt.toISOString(), updatedAt: record.createdAt.toISOString(),
      toolName: '视频生成', error: record.errorMessage,
      results: record.status === 'SUCCESS' && record.videoUrl ? [{ kind: 'video', url: record.videoUrl }] : [],
      pending: [{ nodeId: id, kind: 'video', label: '视频生成中' }],
      ...(record.status === 'PENDING' ? { pollUrl: `/api/video/status/${encodeURIComponent(record.id)}` } : {}),
    })
  }
  return { items: [...tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) }
})
