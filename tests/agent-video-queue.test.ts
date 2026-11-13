import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentStreamHandler } from '@/components/tools/agent-stream-handler'
import { useToolRunStore } from '@/stores/useToolRunStore'

vi.mock('@/lib/browser-notify', () => ({ notify: vi.fn() }))
beforeEach(() => {
  useToolRunStore.setState({ results: [], jobs: [] })
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => vi.unstubAllGlobals())

const handler = () => createAgentStreamHandler({ assistantMsgId: 'reply', patchAssistant: vi.fn() })
describe('Agent 视频成果排队', () => {
  it('视频开始时即有占位，异步提交后接管到持久任务，Agent done 不清除它', () => {
    const stream = handler()
    stream.handleEvent({ type: 'subtask', index: 0, label: '展示（video）', status: 'running', deliverableId: 'video', count: 1 })
    expect(useToolRunStore.getState().results[0]).toMatchObject({ kind: 'video', status: 'running', queueId: 'agent-reply-video' })
    stream.handleEvent({ type: 'pendingVideo', index: 0, recordId: 'record', deliverableId: 'video' })
    stream.handleEvent({ type: 'subtask', index: 0, label: '展示', status: 'processing' })
    stream.handleEvent({ type: 'done', subtasks: [{ status: 'processing' }] })
    expect(useToolRunStore.getState().results).toHaveLength(1)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ kind: 'video', status: 'running', queueId: 'recovery:video:record' })
  })

  it('同步视频按 deliverableId/index 落位，不遗留占位或误当图片', () => {
    const stream = handler()
    stream.handleEvent({ type: 'subtask', index: 0, label: '展示（video）', status: 'running', deliverableId: 'video' })
    stream.handleEvent({ type: 'media', kind: 'video', url: 'https://example.com/a.mp4', deliverableId: 'video', index: 0 })
    expect(useToolRunStore.getState().results).toHaveLength(1)
    expect(useToolRunStore.getState().results[0]).toMatchObject({ kind: 'video', status: 'done', url: 'https://example.com/a.mp4' })
  })

  it('一批多个异步视频逐个绑定，不串占位，不重复卡片', () => {
    const stream = handler()
    stream.handleEvent({ type: 'subtask', index: 0, label: '展示（video）', status: 'running', deliverableId: 'video', count: 2 })
    stream.handleEvent({ type: 'pendingVideo', index: 1, recordId: 'second', deliverableId: 'video' })
    stream.handleEvent({ type: 'pendingVideo', index: 0, recordId: 'first', deliverableId: 'video' })
    expect(useToolRunStore.getState().results).toHaveLength(2)
    expect(useToolRunStore.getState().results.map((item) => item.queueId).sort()).toEqual(['recovery:video:first', 'recovery:video:second'])
  })
})
