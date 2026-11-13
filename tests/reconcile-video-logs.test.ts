import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileVideoUsageLogs } from '@/lib/reconcile-video-logs'
import { isUsageError, USAGE_FAILURE_WHERE } from '@/lib/usage-log-state'

type FixtureLog = { id: string; runId: string; userId: string; modelId: string; statusCode: number; taskId: string | null; requestJson: string; responseJson: string; createdAt: Date; durationMs: number; beansDeducted: number }
type FixtureRecord = { id: string; runId: string; userId: string; modelId: string; status: string; meta: { taskId: string }; videoUrl: string | null; errorMessage: string | null }
const fixture = vi.hoisted(() => ({ logs: [] as FixtureLog[], records: [] as FixtureRecord[], updates: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({
  apiUsageLog: {
    findMany: async (args: { select?: unknown }) => args.select ? fixture.logs : fixture.logs.filter((log) => log.statusCode === 202),
    updateMany: fixture.updates,
  },
  videoGenerationRecord: { findMany: async () => fixture.records },
}) }))

const log = (id = 'log'): FixtureLog => ({ id, runId: 'run', userId: 'owner', modelId: 'model', statusCode: 202,
  taskId: null, requestJson: '{"count":1}', responseJson: '{"pending":true}', createdAt: new Date('2026-11-10T16:00:00Z'), durationMs: 816, beansDeducted: 100 })
const record = (id = 'record', status = 'SUCCESS'): FixtureRecord => ({ id, runId: 'run', userId: 'owner', modelId: 'model', status,
  meta: { taskId: `upstream-${id}` }, videoUrl: status === 'SUCCESS' ? `https://example.com/${id}.mp4` : null, errorMessage: status === 'FAILED' ? '上游失败' : null })

beforeEach(() => {
  fixture.logs = [log()]
  fixture.records = [record()]
  fixture.updates.mockReset().mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<FixtureLog> }) => {
    const target = fixture.logs.find((item) => item.id === where.id && item.statusCode === 202)
    if (!target) return { count: 0 }
    Object.assign(target, data)
    return { count: 1 }
  })
})

describe('运维异步视频日志对账（只同步日志，不触发生成或退款）', () => {
  it('唯一关联时补任务号与真实成果，保留提交耗时和原扣费', async () => {
    await reconcileVideoUsageLogs()
    expect(fixture.logs[0]).toMatchObject({ statusCode: 200, taskId: 'upstream-record', durationMs: 816, beansDeducted: 100 })
    expect(JSON.parse(fixture.logs[0].responseJson)).toMatchObject({ pending: false, url: 'https://example.com/record.mp4', submissionDurationMs: 816 })
  })

  it('仍在生成只补关联，不伪装完成', async () => {
    fixture.records[0] = record('record', 'PENDING')
    await reconcileVideoUsageLogs()
    expect(fixture.logs[0]).toMatchObject({ statusCode: 202, taskId: 'upstream-record', beansDeducted: 100 })
  })

  it('同运行五条缺号旧日志：全组成功可以校正成功，但不猜每条任务号/视频', async () => {
    fixture.logs = Array.from({ length: 5 }, (_, index) => log(`log-${index}`))
    fixture.records = Array.from({ length: 5 }, (_, index) => record(`record-${index}`))
    await reconcileVideoUsageLogs()
    for (const item of fixture.logs) {
      expect(item.statusCode).toBe(200)
      expect(item.taskId).toBeNull()
      expect(JSON.parse(item.responseJson)).toMatchObject({ legacyAmbiguous: true, url: null, videoUrls: [], confirmationDurationMs: null })
    }
  })

  it('旧日志归属不确定且组内尚未全部成功时，不猜结果', async () => {
    fixture.logs = [log('first'), log('second')]
    fixture.records = [record('first'), record('second', 'PENDING')]
    await reconcileVideoUsageLogs()
    expect(fixture.updates).not.toHaveBeenCalled()
  })

  it('多视频聚合调用必须全部结束，第二个任务也能触发日志收尾', async () => {
    fixture.logs[0].taskId = 'upstream-first'
    fixture.logs[0].responseJson = '{"recordIds":["first","second"]}'
    fixture.records = [record('first'), record('second', 'PENDING')]
    expect(await reconcileVideoUsageLogs('upstream-first')).toBe(true)
    expect(fixture.logs[0].statusCode).toBe(202)
    fixture.records[1] = record('second')
    expect(await reconcileVideoUsageLogs('upstream-second')).toBe(true)
    expect(fixture.logs[0].statusCode).toBe(200)
  })

  it('真实失败反映错误，既有扣豆数不被改写', async () => {
    fixture.records[0] = record('record', 'FAILED')
    await reconcileVideoUsageLogs()
    expect(fixture.updates).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ statusCode: 500, errorMessage: '上游失败' }) }))
    expect(fixture.logs[0].beansDeducted).toBe(100)
  })

  it('聚合记录缺失时，不能因其中一个成功任务就把整批日志完成', async () => {
    fixture.logs[0].taskId = 'upstream-record'
    fixture.logs[0].responseJson = '{"recordIds":["record","missing"]}'
    expect(await reconcileVideoUsageLogs('upstream-record')).toBe(true)
    expect(fixture.updates).not.toHaveBeenCalled()
  })

  it('同 runId 的其他用户或模型记录不能拿来认领', async () => {
    fixture.records[0].userId = 'other'
    await reconcileVideoUsageLogs()
    expect(fixture.updates).not.toHaveBeenCalled()
  })
})

describe('运维成功/进行中/失败口径', () => {
  it('202 与 200 均不进入失败，失败筛选排除二者', () => {
    expect(isUsageError(200)).toBe(false)
    expect(isUsageError(202)).toBe(false)
    expect(isUsageError(500)).toBe(true)
    expect(isUsageError(null)).toBe(true)
    expect(USAGE_FAILURE_WHERE).toEqual({ OR: [{ statusCode: { notIn: [200, 202] } }, { statusCode: null }] })
  })
})
