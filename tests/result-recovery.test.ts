import { describe, expect, it } from 'vitest'
import { reconcileRecoveredTasks, type RecoverableTask } from '@/lib/result-recovery'
import { mergeRecoveredResults, type ResultItem } from '@/stores/useToolRunStore'
import { extractAgentResults, extractCanvasResults } from '@/lib/recoverable-media'

const task = (patch: Partial<RecoverableTask> = {}): RecoverableTask => ({
  id: 'run-1', status: 'PENDING', toolName: '视频生成',
  createdAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:01:00Z',
  pending: [{ nodeId: 'video', kind: 'video', label: '首尾帧' }], results: [], ...patch,
})

describe('刷新后恢复成果任务', () => {
  it('刷新后已失败的视频只显示一张失败卡，后续拿到成品时清除错误卡', () => {
    const failed = task({ id: 'video:record', status: 'FAILED', error: '上游失败' })
    const first = reconcileRecoveredTasks([], [failed])
    const second = reconcileRecoveredTasks(first, [failed])
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ status: 'error', claimedRunId: 'video:record' })
    expect(reconcileRecoveredTasks(second, [{ ...failed, status: 'SUCCEEDED' }])).toEqual([])
  })

  it('空本地快照从服务端恢复排队，再推进到生成中，不累积占位', () => {
    const queued = reconcileRecoveredTasks([], [task()])
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ status: 'running', phase: 'queued', kind: 'video' })
    const running = reconcileRecoveredTasks(queued, [task({ status: 'RUNNING' })])
    expect(running).toHaveLength(1)
    expect(running[0].phase).toBe('running')
    expect(running[0].phaseSince).toBe(queued[0].phaseSince)
  })

  it('完成后原有占位消失，产物去重且遵守删除名单', () => {
    const running = reconcileRecoveredTasks([], [task()])
    const completed = reconcileRecoveredTasks(running, [task({ status: 'SUCCEEDED' })])
    const image: ResultItem = { url: 'https://example.com/a.gif', nodeId: 'video', kind: 'image', status: 'done' }
    const recovered = mergeRecoveredResults(completed, [image], new Set())
    expect(recovered).toEqual([image])
    expect(mergeRecoveredResults(recovered, [image], new Set())).toEqual([image])
    expect(mergeRecoveredResults(completed, [image], new Set([image.url]))).toEqual([])
  })

  it('独立认领工具、Agent、电商和批处理任务，一条失败不影响其他任务', () => {
    const tasks = ['tool', 'agent:1', 'ecom:1', 'batch'].map((id) => task({ id }))
    const running = reconcileRecoveredTasks([], tasks)
    expect(running).toHaveLength(4)
    const failed = reconcileRecoveredTasks(running, tasks.map((item) => item.id === 'ecom:1' ? { ...item, status: 'FAILED', error: '审核失败' } : item))
    expect(failed.filter((item) => item.status === 'running')).toHaveLength(3)
    expect(failed.find((item) => item.status === 'error')?.failReason).toBe('审核失败')
  })

  it('当前会话的 SSE 占位保持不变，后台部分产出不终结剩余任务', () => {
    const live: ResultItem = { url: '', kind: 'image', nodeId: 'live', status: 'running', queueId: 'local' }
    const next = reconcileRecoveredTasks([live], [task({ status: 'RUNNING' })])
    expect(next).toContain(live)
    expect(next.filter((item) => item.status === 'running')).toHaveLength(2)
  })

  it('无运行占位的历史失败不会不断生成错误卡片', () => {
    expect(reconcileRecoveredTasks([], [task({ status: 'FAILED' })])).toEqual([])
  })
})

describe('服务端成果提取', () => {
  it('画布恢复限定成果节点，兼容视频和音频复数端口', () => {
    expect(extractCanvasResults({ upload: { imageUrl: 'reference' }, output: { videoUrls: ['v1', 'v2'], audioUrls: ['a1'] } }, ['output'])).toEqual([
      { nodeId: 'output', kind: 'video', url: 'v1' },
      { nodeId: 'output', kind: 'video', url: 'v2' },
      { nodeId: 'output', kind: 'audio', url: 'a1' },
    ])
  })

  it('Agent 保留部分成功的产物，不认领失败子任务的 URL', () => {
    expect(extractAgentResults([
      { status: 'success', title: '视频', videoUrls: ['v1'] },
      { status: 'failed', imageUrl: 'failed' },
    ])).toEqual([{ kind: 'video', url: 'v1', label: '视频' }])
  })
})
