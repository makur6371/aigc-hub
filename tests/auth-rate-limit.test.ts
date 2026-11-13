import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 认证爆破限流的持久化语义（计划 3.3 / Q-D21、Q-D19）。
 *
 * 锁死四件事：
 *   1. 只计失败：peek 不计数，recordAuthFailure 才计数；
 *   2. 超限后不再累加（防止 count 被推成无意义的大数）；
 *   3. 成功清零：clearAuthFailures 后重新放行（打字错误不留尾账）；
 *   4. 限流自身故障必须**放行**，绝不能锁死正常登录。
 */

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))

import { clearAuthFailures, peekAuthRateLimit, recordAuthFailure } from '@/lib/auth-rate-limit'

/** 内存假表：模拟 rate_limits 的唯一键 [ip, action, windowAt] 与条件更新 */
function makeFakePrisma(opts: { throwOn?: 'read' | 'write' } = {}) {
  const rows = new Map<string, number>()
  const k = (ip: string, action: string, windowAt: Date) => `${ip}|${action}|${windowAt.toISOString()}`
  return {
    rows,
    rateLimit: {
      findUnique: async ({ where }: { where: { ip_action_windowAt: { ip: string; action: string; windowAt: Date } } }) => {
        if (opts.throwOn === 'read') throw new Error('db down')
        const { ip, action, windowAt } = where.ip_action_windowAt
        const c = rows.get(k(ip, action, windowAt))
        return c == null ? null : { count: c }
      },
      updateMany: async ({ where, data }: { where: { ip: string; action: string; windowAt: Date; count?: { lt: number } }; data: { count: { increment: number } } }) => {
        if (opts.throwOn === 'write') throw new Error('db down')
        const key = k(where.ip, where.action, where.windowAt)
        const cur = rows.get(key)
        if (cur == null) return { count: 0 }
        if (where.count?.lt != null && cur >= where.count.lt) return { count: 0 }
        rows.set(key, cur + data.count.increment)
        return { count: 1 }
      },
      create: async ({ data }: { data: { ip: string; action: string; windowAt: Date; count: number } }) => {
        if (opts.throwOn === 'write') throw new Error('db down')
        const key = k(data.ip, data.action, data.windowAt)
        if (rows.has(key)) throw new Error('UNIQUE constraint failed: rate_limits.ip, rate_limits.action, rate_limits.window_at')
        rows.set(key, data.count)
        return { id: 'row' }
      },
      deleteMany: async ({ where }: { where: { ip: string; action: string; windowAt: Date } }) => {
        const key = k(where.ip, where.action, where.windowAt)
        const had = rows.delete(key)
        return { count: had ? 1 : 0 }
      },
    },
  }
}

const CFG = { windowMs: 15 * 60 * 1000, maxRequests: 5 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('认证限流持久化语义', () => {
  it('peek 只读不计数；record 才累加；到上限后 blocked', async () => {
    const fake = makeFakePrisma()
    mocks.getPrisma.mockResolvedValue(fake)

    for (let i = 0; i < 5; i++) {
      const before = await peekAuthRateLimit('1.1.1.1', 'login:ip', CFG)
      expect(before.allowed).toBe(true)
      expect(before.remaining).toBe(5 - i)
      await recordAuthFailure('1.1.1.1', 'login:ip', CFG)
    }
    const blocked = await peekAuthRateLimit('1.1.1.1', 'login:ip', CFG)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('超限后继续失败不再累加 count', async () => {
    const fake = makeFakePrisma()
    mocks.getPrisma.mockResolvedValue(fake)
    for (let i = 0; i < 8; i++) await recordAuthFailure('2.2.2.2', 'login:account', CFG)
    expect([...fake.rows.values()]).toEqual([5])
  })

  it('登录成功清空计数后重新放行（打字错误不留尾账）', async () => {
    const fake = makeFakePrisma()
    mocks.getPrisma.mockResolvedValue(fake)
    for (let i = 0; i < 5; i++) await recordAuthFailure('3.3.3.3', 'login:ip', CFG)
    expect((await peekAuthRateLimit('3.3.3.3', 'login:ip', CFG)).allowed).toBe(false)
    await clearAuthFailures('3.3.3.3', 'login:ip', CFG.windowMs)
    const after = await peekAuthRateLimit('3.3.3.3', 'login:ip', CFG)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(5)
  })

  it('DB 读失败 → 放行（限流故障不得锁死正常登录）', async () => {
    mocks.getPrisma.mockResolvedValue(makeFakePrisma({ throwOn: 'read' }))
    const r = await peekAuthRateLimit('4.4.4.4', 'login:ip', CFG)
    expect(r.allowed).toBe(true)
  })

  it('DB 写失败 → 静默降级不抛（不能因为计数失败炸掉登录流程）', async () => {
    mocks.getPrisma.mockResolvedValue(makeFakePrisma({ throwOn: 'write' }))
    await expect(recordAuthFailure('5.5.5.5', 'login:ip', CFG)).resolves.toBeUndefined()
  })

  it('表缺失（no such table）→ 仍放行，但日志必须给出「防护不生效」的明确指引', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getPrisma.mockResolvedValue({
      rateLimit: {
        findUnique: async () => { throw new Error('SqliteError: no such table: rate_limits') },
      },
    })
    const r = await peekAuthRateLimit('8.8.8.8', 'login:ip', CFG)
    expect(r.allowed).toBe(true)
    const logged = spy.mock.calls.map((c) => String(c[1] ?? '')).join('\n')
    expect(logged).toContain('rate_limits 未建')
    expect(logged).toContain('爆破防护当前不生效')
    spy.mockRestore()
  })

  it('同窗口连续失败走条件递增（第二次起不再建窗）', async () => {
    const fake = makeFakePrisma()
    mocks.getPrisma.mockResolvedValue(fake)
    await recordAuthFailure('6.6.6.6', 'email-verify', CFG) // 建窗 count=1
    await recordAuthFailure('6.6.6.6', 'email-verify', CFG) // 走 updateMany 分支
    expect([...fake.rows.values()]).toEqual([2])
  })

  it('并发首次建窗撞唯一键 → 兜底再条件递增一次，不报错也不双建', async () => {
    // 模拟：本请求 updateMany 未命中（对方还没建行）→ findUnique 为空 → create 撞唯一键
    //（对方抢先建好）→ 走 catch 里的兜底 updateMany 成功。
    let createAttempted = false
    const fake = {
      rateLimit: {
        findUnique: async () => null,
        updateMany: async () => {
          // 第一次（create 之前）未命中；兜底那次命中
          return { count: createAttempted ? 1 : 0 }
        },
        create: async () => {
          createAttempted = true
          throw new Error('UNIQUE constraint failed')
        },
        deleteMany: async () => ({ count: 0 }),
      },
    }
    mocks.getPrisma.mockResolvedValue(fake)
    await expect(recordAuthFailure('7.7.7.7', 'login:ip', CFG)).resolves.toBeUndefined()
    expect(createAttempted).toBe(true)
  })
})
