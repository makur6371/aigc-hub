import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSource } from './helpers/source-guard'

/**
 * Redis 故障必须可见（Q-D49）。
 *
 * ===== 原来的洞 =====
 * ioredis 的连接错误走 `silentEmit('error', err)` —— **没有监听器时它直接丢掉**。
 * 于是 Redis 挂掉的表现是「微信登录莫名失败」，而应用日志里**一个字都没有**，
 * 运维面板（Q-D32 的 error-sink）也完全不知情。与 Q-D32 修之前是同一类盲区。
 *
 * 本批做的两件事：① `getRedis()` 挂上 error 监听并写进 error-sink；
 * ② `system-status` 增加 `redisOk` 并显示在运维面板「系统健康」里。
 *
 * 注意：**依赖关系本身没有改** —— compose 里 app 仍硬依赖 `redis: service_healthy`，
 * 而 Redis 只服务「公众号验证码登录」这一个功能。那个耦合要不要拆属产品决策，
 * 登记在 Q-D49 里，不在这条测试的范围内。
 */

const mocks = vi.hoisted(() => ({
  recordError: vi.fn(),
  errorRecord: vi.fn((scope: string, err: unknown, extra?: Record<string, unknown>) => ({
    ts: '2026-11-01T00:00:00.000Z',
    scope,
    message: err instanceof Error ? err.message : String(err),
    ...(extra ?? {}),
  })),
  instances: [] as Array<{ handlers: Record<string, (...a: unknown[]) => void>; ping: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@/lib/error-sink', () => ({
  recordError: mocks.recordError,
  errorRecord: mocks.errorRecord,
}))

vi.mock('ioredis', () => {
  class FakeRedis {
    handlers: Record<string, (...a: unknown[]) => void> = {}
    ping = vi.fn(async () => 'PONG')
    constructor(_url: string, _opts: unknown) {
      mocks.instances.push(this)
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      this.handlers[event] = fn
      return this
    }
  }
  return { default: FakeRedis }
})

import { getRedis, checkRedisHealth, __resetRedisForTest } from '@/lib/redis'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.instances.length = 0
  // 单例在模块级缓存 —— 不重置的话第二个用例拿到的是上一个用例的实例
  __resetRedisForTest()
})

describe('getRedis 必须挂 error 监听（否则故障被 ioredis 静默吞掉）', () => {
  it('error 事件会进 error-sink，带上可执行的排查 scope', () => {
    const r = getRedis()
    const inst = mocks.instances[0]
    expect(inst, '没有创建客户端').toBeTruthy()
    expect(typeof inst.handlers.error, '没有挂 error 监听 —— 这正是原来的洞').toBe('function')

    // 模拟一次连接失败
    inst.handlers.error(new Error('connect ECONNREFUSED 127.0.0.1:6379'))

    expect(mocks.recordError).toHaveBeenCalledTimes(1)
    const rec = mocks.recordError.mock.calls[0][0]
    expect(rec.scope).toBe('redis')
    expect(rec.message).toContain('ECONNREFUSED')
    expect(rec.path).toBe('lib/redis.ts')
    void r
  })

  it('客户端是单例：重复调用不会重复创建（也就不会重复挂监听）', () => {
    getRedis()
    getRedis()
    expect(mocks.instances).toHaveLength(1)
  })

  it('ready 事件有日志（便于确认「刚才那次故障已自愈」）', () => {
    getRedis()
    const inst = mocks.instances[0]
    expect(typeof inst.handlers.ready).toBe('function')
  })
})

describe('checkRedisHealth —— 面板用的探针，永不抛错', () => {
  it('ping 有响应 → ok', async () => {
    const r = await checkRedisHealth()
    expect(r.ok).toBe(true)
  })

  it('ping 抛错 → ok=false 且带上原因（而不是把异常抛给面板）', async () => {
    const r = await checkRedisHealth()
    void r
    mocks.instances[0].ping.mockRejectedValueOnce(new Error('Redis 连接已断开'))
    const r2 = await checkRedisHealth()
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('Redis 连接已断开')
  })
})

describe('运维面板必须能看到 Redis 状态（源码守卫）', () => {
  it('system-status 返回 redisOk', () => {
    const src = readSource('src/app/api/admin/system-status/route.ts')
    expect(src).toContain('checkRedisHealth')
    expect(src).toMatch(/redisOk:\s*redisHealth\.ok/)
  })

  it('运维面板「系统健康」里有 Redis 卡片', () => {
    const src = readSource('src/components/admin/OpsDashboard.tsx')
    expect(src).toContain('systemStatus?.server.redisOk')
    expect(src).toContain('Redis（微信验证码登录）')
  })
})
