import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/admin/usage-logs/route'

const fixture = vi.hoisted(() => ({ auth: vi.fn(), logs: vi.fn(), reconcile: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ getAuthUser: fixture.auth }))
vi.mock('@/lib/reconcile-video-logs', () => ({ reconcileVideoUsageLogs: fixture.reconcile }))
vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({ apiUsageLog: { findMany: fixture.logs, count: async () => 0 } }) }))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.auth.mockResolvedValue({ userId: 'admin', role: 'ADMIN' })
  fixture.logs.mockResolvedValue([])
  fixture.reconcile.mockResolvedValue(false)
})

describe('运维调用筛选', () => {
  it('失败筛选排除成功与已受理，校正后再分页查询', async () => {
    const response = await GET(new NextRequest('https://example.com/api/admin/usage-logs?status=error'), { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect(fixture.logs).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ statusCode: { notIn: [200, 202] } }, { statusCode: null }] } }))
    expect(fixture.reconcile.mock.invocationCallOrder[0]).toBeLessThan(fixture.logs.mock.invocationCallOrder[0])
  })

  it('进行中筛选只查 202', async () => {
    await GET(new NextRequest('https://example.com/api/admin/usage-logs?status=pending'), { params: Promise.resolve({}) })
    expect(fixture.logs).toHaveBeenCalledWith(expect.objectContaining({ where: { statusCode: 202 } }))
  })

  it('普通用户不能触发日志校正或读取调用记录', async () => {
    fixture.auth.mockResolvedValue({ userId: 'user', role: 'USER' })
    const response = await GET(new NextRequest('https://example.com/api/admin/usage-logs'), { params: Promise.resolve({}) })
    expect(response.status).toBe(403)
    expect(fixture.reconcile).not.toHaveBeenCalled()
    expect(fixture.logs).not.toHaveBeenCalled()
  })
})
