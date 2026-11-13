import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/results/recovery/route'

const fixture = vi.hoisted(() => ({
  auth: vi.fn(), canvas: vi.fn(), agent: vi.fn(), video: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ getAuthUser: fixture.auth }))
vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({
  canvasRun: { findMany: fixture.canvas }, generationTask: { findMany: fixture.agent },
  videoGenerationRecord: { findMany: fixture.video },
}) }))

beforeEach(() => {
  vi.resetAllMocks()
  fixture.auth.mockResolvedValue({ userId: 'owner', role: 'USER' })
  fixture.canvas.mockResolvedValue([])
  fixture.agent.mockResolvedValue([])
  fixture.video.mockResolvedValue([])
})

describe('成果任务恢复接口', () => {
  it('独立恢复本次会话的新异步视频和旧 Agent 提交的视频，不依赖父任务仍在运行', async () => {
    const now = new Date()
    fixture.video.mockResolvedValue([{ id: 'video-1', createdAt: now, status: 'PENDING', errorMessage: null, videoUrl: null }])
    fixture.agent.mockResolvedValue([{ id: 'parent', createdAt: now, updatedAt: now, status: 'SUCCEEDED', error: null,
      payload: { subtasks: [{ type: 'video', status: 'processing', videoPending: true, recordId: 'video-1' }] },
    }])
    const response = await GET(new NextRequest(`https://example.com/api/results/recovery?before=${now.getTime() - 10000}`), { params: Promise.resolve({}) })
    const body = await response.json()
    expect(body.data.items.find((item: { id: string }) => item.id === 'video:video-1')).toMatchObject({ status: 'PENDING', pollUrl: '/api/video/status/video-1' })
    expect(body.data.items.find((item: { id: string }) => item.id === 'agent:parent').pending).toEqual([])
    expect(fixture.video.mock.calls[0][0].where).toEqual({ userId: 'owner', runId: { not: null }, status: 'PENDING' })
    expect(fixture.video.mock.calls[0][0].take).toBeUndefined()
  })

  it('未登录不能查看任务', async () => {
    fixture.auth.mockResolvedValue(null)
    const response = await GET(new NextRequest('https://example.com/api/results/recovery'), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
    expect(fixture.canvas).not.toHaveBeenCalled()
  })

  it('恢复工具视频和 Agent 排队任务，并独立获取全部活跃任务', async () => {
    const now = new Date()
    const common = { createdAt: now, updatedAt: now, error: null }
    fixture.canvas.mockResolvedValue([{ ...common, id: 'tool', status: 'RUNNING', workflowName: '视频生成', resultNodeIds: ['video'], nodes: [{ id: 'video', type: 'video-generate' }], seedOutputs: {} }])
    fixture.agent.mockResolvedValue([{ ...common, id: 'agent', status: 'PENDING', payload: {} }])
    const response = await GET(new NextRequest(`https://example.com/api/results/recovery?before=${now.getTime()}`), { params: Promise.resolve({}) })
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.data.items).toHaveLength(2)
    expect(body.data.items.find((item: { id: string }) => item.id === 'tool').pending[0].kind).toBe('video')
    for (const query of fixture.canvas.mock.calls.map(([args]) => args)) {
      expect(query.where.userId).toBe('owner')
      expect(query.where.surface.in).toEqual(['tool', 'batch'])
    }
    expect(fixture.canvas.mock.calls[0][0].take).toBeUndefined()
    expect(fixture.agent.mock.calls[0][0].take).toBeUndefined()
  })

  it('超时任务收尾，保留已生成的部分成果', async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000)
    fixture.canvas.mockResolvedValue([{ id: 'partial', status: 'RUNNING', createdAt: old, updatedAt: old, error: null,
      workflowName: '套图', nodes: [], resultNodeIds: ['gen-1'], seedOutputs: { 'gen-1': { imageUrl: 'https://example.com/1.gif' } },
    }])
    const response = await GET(new NextRequest('https://example.com/api/results/recovery'), { params: Promise.resolve({}) })
    const body = await response.json()
    expect(body.data.items[0].status).toBe('FAILED')
    expect(body.data.items[0].results[0].url).toBe('https://example.com/1.gif')
  })
})
