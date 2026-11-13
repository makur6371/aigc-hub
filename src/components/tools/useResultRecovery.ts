'use client'

import { useEffect } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useAuthStore } from '@/stores/useAuthStore'
import { mergeRecoveredResults, useToolRunStore, type ResultItem } from '@/stores/useToolRunStore'
import { reconcileRecoveredTasks, type RecoverableTask } from '@/lib/result-recovery'

const recoveryBefore = Date.now()
const subscriptions = new Map<string, { count: number; stop: () => void }>()

export function useResultRecovery() {
  const userId = useAuthStore((state) => state.user?.id)
  useEffect(() => {
    if (!userId) return
    const existing = subscriptions.get(userId)
    if (existing) existing.count++
    else subscriptions.set(userId, { count: 1, stop: startRecovery() })
    return () => {
      const subscription = subscriptions.get(userId)
      if (!subscription || --subscription.count > 0) return
      subscription.stop()
      subscriptions.delete(userId)
    }
  }, [userId])
}

function startRecovery() {
  let alive = true
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let interval = 10000
  const refreshVideoTasks = async (tasks: RecoverableTask[]) => {
    const pending = tasks.filter((task) => task.pollUrl)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (alive && cursor < pending.length) {
        const task = pending[cursor++]
        const result = await apiFetch<{ status: string; videoUrl?: string; error?: string }>(task.pollUrl!, { cache: 'no-store' })
        if (!result.success || !result.data) continue
        if (result.data.status === 'SUCCESS' && result.data.videoUrl) {
          task.status = 'SUCCEEDED'
          task.results = [{ kind: 'video', url: result.data.videoUrl }]
        } else if (result.data.status === 'FAILED') {
          task.status = 'FAILED'
          task.error = result.data.error
        }
      }
    }))
  }
  const recover = async () => {
    if (busy || !alive) return
    busy = true
    try {
      const body = await apiFetch<{ items: RecoverableTask[] }>(`/api/results/recovery?before=${recoveryBefore}`, { cache: 'no-store' })
      if (!alive || !body.success || !Array.isArray(body.data?.items)) return
      const tasks = body.data.items
      useToolRunStore.getState().setResults((prev) => reconcileRecoveredTasks(prev, tasks))
      await refreshVideoTasks(tasks)
      if (!alive) return
      interval = tasks.some((task) => task.status === 'RUNNING' || task.status === 'PENDING') ? 5000 : 30000
      useToolRunStore.getState().setResults((prev) => {
        const recovered: ResultItem[] = tasks.flatMap((task) => task.results.map((result) => ({
          url: result.url, kind: result.kind, nodeId: result.nodeId || task.id, status: 'done' as const,
          claimedRunId: task.id, styleLabel: result.label, toolName: task.toolName,
          createdAt: new Date(task.createdAt).getTime(),
        })))
        return mergeRecoveredResults(reconcileRecoveredTasks(prev, tasks), recovered)
      })
    } catch { /* 下次轮询重试 */ }
    finally {
      busy = false
      if (alive) timer = setTimeout(recover, document.hidden ? 30000 : interval)
    }
  }
  const wake = () => {
    if (document.hidden) return
    clearTimeout(timer)
    void recover()
  }
  void recover()
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  window.addEventListener('toolhub:recover-results', wake)
  document.addEventListener('visibilitychange', wake)
  return () => {
    alive = false
    clearTimeout(timer)
    window.removeEventListener('focus', wake)
    window.removeEventListener('online', wake)
    window.removeEventListener('toolhub:recover-results', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}
