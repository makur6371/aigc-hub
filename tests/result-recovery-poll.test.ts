import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResultRecovery } from '@/components/tools/useResultRecovery'
import { useToolRunStore } from '@/stores/useToolRunStore'

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), effect: null as null | (() => void | (() => void)) }))
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => { fixture.effect = effect } }))
vi.mock('@/stores/useAuthStore', () => ({ useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'owner' } }) }))
vi.mock('@/lib/api-client', () => ({ apiFetch: fixture.fetch }))

let cleanup: void | (() => void)
const task = { id: 'run', toolName: '图像生成', status: 'RUNNING', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  results: [], pending: [{ kind: 'image', nodeId: 'gen' }] }

beforeEach(() => {
  vi.useFakeTimers()
  fixture.fetch.mockReset()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  useToolRunStore.setState({ results: [], jobs: [] })
})
afterEach(() => {
  cleanup?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('工作台刷新恢复轮询', () => {
  it('异步视频调用状态接口跟进完成，替换占位，使用视频而非图片类型', async () => {
    const video = { ...task, id: 'video:record', pollUrl: '/api/video/status/record', pending: [{ kind: 'video', nodeId: 'record' }] }
    let polls = 0
    fixture.fetch.mockImplementation(async (url: string) => {
      if (url === video.pollUrl) return { success: true, data: ++polls === 1 ? { status: 'PENDING' } : { status: 'SUCCESS', videoUrl: 'https://example.com/out.mp4' } }
      return { success: true, data: { items: [structuredClone(video)] } }
    })
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ kind: 'video', status: 'running' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(useToolRunStore.getState().results).toHaveLength(1)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ kind: 'video', status: 'done', url: 'https://example.com/out.mp4' })
  })

  it('异步视频真正失败后收尾并显示失败原因', async () => {
    fixture.fetch.mockImplementation(async (url: string) => url.startsWith('/api/video/status/')
      ? { success: true, data: { status: 'FAILED', error: '上游生成失败' } }
      : { success: true, data: { items: [{ ...task, id: 'video:record', pollUrl: '/api/video/status/record', pending: [{ kind: 'video', nodeId: 'record' }] }] } })
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ status: 'error', failReason: '上游生成失败' })
  })

  it('刷新后恢复生成占位，无需再刷新即可用完成结果替换占位', async () => {
    fixture.fetch.mockResolvedValueOnce({ success: true, data: { items: [task] } })
      .mockResolvedValue({ success: true, data: { items: [{ ...task, status: 'SUCCEEDED', pending: [], results: [{ kind: 'image', url: 'https://example.com/generated.gif' }] }] } })
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(useToolRunStore.getState().results[0].status).toBe('running')
    await vi.advanceTimersByTimeAsync(5000)
    expect(useToolRunStore.getState().results).toHaveLength(1)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ status: 'done', url: 'https://example.com/generated.gif' })
  })

  it('临时断网后继续恢复，不会因第一次请求失败永久停止轮询', async () => {
    fixture.fetch.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ success: true, data: { items: [task] } })
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
    expect(useToolRunStore.getState().results[0].status).toBe('running')
  })

  it('离开工作台后停止轮询', async () => {
    fixture.fetch.mockResolvedValue({ success: true, data: { items: [task] } })
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(0)
    cleanup?.()
    cleanup = undefined
    await vi.advanceTimersByTimeAsync(60000)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
  })

  it('创作三个模式同时保留挂载时，共用一条轮询，最后卸载才停止', async () => {
    fixture.fetch.mockResolvedValue({ success: true, data: { items: [task] } })
    useResultRecovery()
    const first = fixture.effect?.()
    useResultRecovery()
    cleanup = fixture.effect?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    first?.()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })
})
