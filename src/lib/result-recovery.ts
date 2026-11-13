import type { ResultItem } from '@/stores/useToolRunStore'

export type RecoverableTask = {
  id: string
  status: string
  createdAt: string
  updatedAt: string
  toolName: string
  error?: string | null
  pollUrl?: string
  results: Array<{ nodeId?: string; kind: ResultItem['kind']; url: string; label?: string }>
  pending: Array<{ nodeId: string; kind: ResultItem['kind']; label?: string }>
}

export function reconcileRecoveredTasks(prev: ResultItem[], tasks: RecoverableTask[]): ResultItem[] {
  const next = [...prev]
  const pending: ResultItem[] = []
  for (const task of tasks) {
    const queueId = `recovery:${task.id}`
    const active = task.status === 'RUNNING' || task.status === 'PENDING'
    const belongs = (item: ResultItem) => item.queueId === queueId || (item.claimedRunId === task.id && item.status === 'error')
    const oldSlots = next.filter(belongs)
    for (let index = next.length - 1; index >= 0; index--) {
      if (belongs(next[index])) next.splice(index, 1)
    }
    if (active) {
      task.pending.forEach((slot, index) => pending.push({
        url: '', kind: slot.kind, nodeId: slot.nodeId, status: 'running',
        queueId, queueIndex: index, queueNote: slot.label, toolName: task.toolName,
        phase: task.status === 'PENDING' ? 'queued' : 'running',
        phaseSince: new Date(task.createdAt).getTime(),
        createdAt: new Date(task.createdAt).getTime(),
      }))
    } else if ((oldSlots.length || task.id.startsWith('video:')) && task.status !== 'SUCCEEDED') {
      const slot = task.pending[0]
      next.push({ url: '', kind: slot?.kind || 'video', nodeId: slot?.nodeId || task.id,
        toolName: task.toolName, createdAt: new Date(task.createdAt).getTime(),
        ...oldSlots.at(0), status: 'error', queueId: undefined, claimedRunId: task.id,
        failReason: task.error || (task.status === 'CANCELLED' ? '已取消' : '任务已结束，请查看记录'),
      })
    }
  }
  return [...pending, ...next]
}
