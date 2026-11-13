import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSource, assertNotMatches } from './helpers/source-guard'

/**
 * 管理操作留痕（Q-D42）。
 *
 * 锁三件事：
 *  1. **涉钱 / 涉账号的变更与留痕必须在同一个事务里** —— 分开提交时，
 *     「钱改了但查不到是谁干的」和「已通过审核但作者没拿到奖励」都会静默发生；
 *  2. 留痕只有一个写入入口（`lib/admin-audit.ts`），路由里不许再裸写 `adminActionLog.create`，
 *     否则下一个新增的后台接口照样会漏；
 *  3. 留痕内容本身可信：指向被操作人、note 截断、**不含明文密码**。
 *
 * 事务回滚在无 DB 环境下无法真验，这里沿用 `tests/charge-atomic.test.ts` 的做法：
 * 用 fake tx 断言「同一个 tx 对象 + 任一抛错即整体 reject」这一结构契约。
 */

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  requireAuth: vi.fn(),
  adjustPoints: vi.fn(),
  adjustBeans: vi.fn(),
  recordError: vi.fn(),
  errorRecord: vi.fn((scope: string, err: unknown) => ({
    ts: '2026-11-01T00:00:00.000Z',
    scope,
    message: err instanceof Error ? err.message : String(err),
  })),
}))

vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }))
vi.mock('@/lib/error-sink', () => ({
  recordError: mocks.recordError,
  errorRecord: mocks.errorRecord,
  readRecentErrors: vi.fn(),
}))
vi.mock('@/lib/billing/wallet', () => ({
  adjustPoints: mocks.adjustPoints,
  adjustBeans: mocks.adjustBeans,
}))
// 只换掉鉴权出口，apiHandler 的包装语义（Response 信封、错误降级）保持真实
vi.mock('@/lib/api-handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-handler')>()
  return { ...actual, requireAuth: mocks.requireAuth }
})

import { writeAdminAction, recordAdminAction, __internals } from '@/lib/admin-audit'
import { POST as adjustPointsRoute } from '@/app/api/admin/users/[id]/points/route'
import { POST as adjustBeansRoute } from '@/app/api/admin/users/[id]/beans/route'
import { POST as resetPasswordRoute } from '@/app/api/admin/users/[id]/reset-password/route'
import { POST as toolReviewRoute } from '@/app/api/admin/tools/[id]/review/route'

const ADMIN = { userId: 'admin-1', phone: ('139' + '00000000'), role: 'ADMIN' }
const TARGET = {
  id: 'u-target',
  phone: ('138' + '00001111'),
  nickname: '小明',
  role: 'USER',
  status: 'NORMAL',
  points: 100,
  beans: 50,
  billingType: 'POINTS',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
}

/** 造一个带 fake 事务的 prisma：$transaction 把同一个 tx 交给回调，回调抛错就整体 reject。 */
function makeDb() {
  const tx = {
    user: {
      findUnique: vi.fn(async () => ({ ...TARGET })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'u-target', ...data })),
    },
    tool: {
      findUnique: vi.fn(async () => ({ id: 'tool-1', name: '电商主图', authorId: 'author-1', status: 'PENDING', isOfficial: false })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tool-1', status: 'APPROVED', isOfficial: false, ...data })),
    },
    // 替身签名与本模块的 AdminLogWriter 对齐，否则 .mock.calls[0][0] 在类型上是空元组
    adminActionLog: { create: vi.fn(async (_args: { data: unknown }) => ({})) },
    pointsLog: { create: vi.fn(async () => ({})) },
  }
  const prisma = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) }
  return { prisma, tx }
}

function post(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body) })
}

const auditOf = (tx: ReturnType<typeof makeDb>['tx']) =>
  (tx.adminActionLog.create.mock.calls[0]?.[0] as { data: never }).data as {
    adminId: string; userId: string; action: string; note: string | null
  }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireAuth.mockResolvedValue(ADMIN)
  mocks.adjustPoints.mockResolvedValue(undefined)
  mocks.adjustBeans.mockResolvedValue(undefined)
})

describe('writeAdminAction / recordAdminAction —— 唯一写入入口的形状契约', () => {
  it('写全 adminId / userId / action / note 四个字段', async () => {
    const { prisma, tx } = makeDb()
    await writeAdminAction(tx, { adminId: 'a1', userId: 'u1', action: 'points_adjust', note: '加了 10 积分' })
    expect(tx.adminActionLog.create).toHaveBeenCalledWith({
      data: { adminId: 'a1', userId: 'u1', action: 'points_adjust', note: '加了 10 积分' },
    })
    void prisma
  })

  it('note 超长截断到 500：留痕是证据不是文章，截断好过写入失败', async () => {
    const { tx } = makeDb()
    await writeAdminAction(tx, { adminId: 'a1', userId: 'u1', action: 'x', note: '长'.repeat(__internals.NOTE_MAX + 200) })
    expect(auditOf(tx).note).toHaveLength(__internals.NOTE_MAX)
  })

  it('缺 adminId / userId / action 直接抛错，绝不写空壳留痕', async () => {
    const { tx } = makeDb()
    await expect(writeAdminAction(tx, { userId: 'u1', action: 'a' } as never)).rejects.toThrow(/adminId/)
    await expect(writeAdminAction(tx, { adminId: 'a1', action: 'a' } as never)).rejects.toThrow(/userId/)
    await expect(writeAdminAction(tx, { adminId: 'a1', userId: 'u1' } as never)).rejects.toThrow(/action/)
    expect(tx.adminActionLog.create).not.toHaveBeenCalled()
  })

  it('把对象身份编码进 action 的写法直接拒绝（动作码要能统计，身份属于 note）', async () => {
    const { tx } = makeDb()
    await expect(
      writeAdminAction(tx, { adminId: 'a1', userId: 'u1', action: 'delete_user:u-target:example number' }),
    ).rejects.toThrow(/snake_case/)
    await expect(writeAdminAction(tx, { adminId: 'a1', userId: 'u1', action: 'Delete User' })).rejects.toThrow(/snake_case/)
    expect(tx.adminActionLog.create).not.toHaveBeenCalled()
  })

  it('action 过长也拒：防止靠「动作码里塞描述」绕开上条规则', async () => {
    const { tx } = makeDb()
    await expect(
      writeAdminAction(tx, { adminId: 'a1', userId: 'u1', action: 'a'.repeat(__internals.ACTION_MAX + 1) }),
    ).rejects.toThrow(/action 过长/)
  })

  it('recordAdminAction 永不抛错，但把「丢了哪条留痕」落进错误面板', async () => {
    mocks.getPrisma.mockRejectedValue(new Error('DB 连接断了'))
    await expect(
      recordAdminAction({ adminId: 'a1', userId: 'u1', action: 'points_adjust' }),
    ).resolves.toBeUndefined()
    expect(mocks.recordError).toHaveBeenCalledTimes(1)
    const rec = mocks.recordError.mock.calls[0][0]
    expect(rec.scope).toBe('admin-audit')
    // 面板里只看得到 stack 的话，运维知道在报错却不知道丢了哪条证据
    expect(rec.message).toContain('action=points_adjust')
    expect(rec.message).toContain('admin=a1')
  })
})

describe('POST /api/admin/users/[id]/points —— 余额与留痕同事务', () => {
  it('adjustPoints 与留痕拿到同一个 tx', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)

    const res = await adjustPointsRoute(post('http://x/api/admin/users/u-target/points', { amount: 10, reason: '补偿' }) as never, {
      params: Promise.resolve({ id: 'u-target' }),
    })
    expect(res.status).toBe(200)

    // 第 4 个参数是 tx：传进来才可能并进同一个事务
    expect(mocks.adjustPoints).toHaveBeenCalledWith('u-target', 10, '补偿', tx)
    expect(tx.adminActionLog.create).toHaveBeenCalledTimes(1)
    const audit = auditOf(tx)
    expect(audit.adminId).toBe('admin-1')
    expect(audit.userId).toBe('u-target') // 指向被调整的人，不是管理员自己
    expect(audit.action).toBe('points_adjust')
    expect(audit.note).toContain('+10')
    expect(audit.note).toContain('补偿')
  })

  it('留痕写失败会把整个事务顶掉：不允许「钱改了但没证据」', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)
    tx.adminActionLog.create.mockRejectedValue(new Error('留痕表写入失败'))

    const res = await adjustPointsRoute(post('http://x/api/admin/users/u-target/points', { amount: -5 }) as never, {
      params: Promise.resolve({ id: 'u-target' }),
    })
    // 断言的是「留痕失败没被 route 吞掉」：错误必须一路顶出 $transaction，
    // 由 $transaction 的语义整体回滚，因此响应必然是一次失败的调用。
    // （裸 Error 被 apiHandler 统一降级成 400 是既有约定，见 lib/api-handler.ts，
    //  这里不去锁状态码，锁的是「不会假装成功」。）
    expect(res.status).not.toBe(200)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.message).toContain('留痕表写入失败')
    // 余额写与留痕都试过，且都在同一次事务里
    expect(mocks.adjustPoints).toHaveBeenCalledTimes(1)
    expect(tx.adminActionLog.create).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/admin/users/[id]/beans —— 与积分入口对称', () => {
  it('adjustBeans 与留痕同一个 tx，动作码独立可统计', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)

    await adjustBeansRoute(post('http://x/api/admin/users/u-target/beans', { amount: -3, reason: '误发回收' }) as never, {
      params: Promise.resolve({ id: 'u-target' }),
    })
    expect(mocks.adjustBeans).toHaveBeenCalledWith('u-target', -3, '误发回收', tx)
    expect(auditOf(tx).action).toBe('beans_adjust')
    expect(auditOf(tx).note).toContain('-3')
  })
})

describe('POST /api/admin/users/[id]/reset-password —— 重置他人密码必须可追责', () => {
  it('改密码与留痕同事务，且 note 里绝不出现明文新密码', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)

    await resetPasswordRoute(post('http://x/api/admin/users/u-target/reset-password', { password: 'MySecret123' }) as never, {
      params: Promise.resolve({ id: 'u-target' }),
    })
    expect(tx.user.update).toHaveBeenCalledTimes(1)
    const data = tx.user.update.mock.calls[0][0].data
    expect(data.passwordHash).toBeTruthy()
    expect(data.tokenVersion).toEqual({ increment: 1 }) // 作废旧会话（Q-506）

    const audit = auditOf(tx)
    expect(audit.action).toBe('password_reset')
    expect(audit.userId).toBe('u-target')
    expect(audit.note).not.toContain('MySecret123')
    expect(audit.note).toContain('作废')
  })
})

describe('POST /api/admin/tools/[id]/review —— 状态、奖励、留痕同事务', () => {
  it('三个写操作共用一个 tx：杜绝「工具已通过、作者奖励没发」的哑账', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)

    const res = await toolReviewRoute(post('http://x/api/admin/tools/tool-1/review', { action: 'approve', points: 200 }) as never, {
      params: Promise.resolve({ id: 'tool-1' }),
    })
    expect(res.status).toBe(200)
    expect(tx.tool.update).toHaveBeenCalledTimes(1)
    expect(mocks.adjustPoints).toHaveBeenCalledWith('author-1', 200, expect.stringContaining('电商主图'), tx)
    const audit = auditOf(tx)
    expect(audit.userId).toBe('author-1') // 受影响的是作者
    expect(audit.action).toBe('tool_approve')
    expect(audit.note).toContain('200')
  })

  it('驳回不发奖励时也要留痕', async () => {
    const { prisma, tx } = makeDb()
    mocks.getPrisma.mockResolvedValue(prisma)

    await toolReviewRoute(post('http://x/api/admin/tools/tool-1/review', { action: 'reject' }) as never, {
      params: Promise.resolve({ id: 'tool-1' }),
    })
    expect(mocks.adjustPoints).not.toHaveBeenCalled()
    expect(auditOf(tx).action).toBe('tool_reject')
  })
})

describe('唯一写入口（源码守卫）', () => {
  /**
   * 递归扫 `src/app/api/admin` 下所有路由，而不是手写一份文件清单 ——
   * 手写清单会**静默漏掉下一个新增的后台接口**，而那正是这条守卫要防的场景。
   */
  function walkAdminRoutes(dir = 'src/app/api/admin', out: string[] = []): string[] {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${name}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) walkAdminRoutes(rel, out)
      else if (name === 'route.ts') out.push(rel)
    }
    return out
  }
  const adminRoutes = walkAdminRoutes()

  it('扫描范围自检：确实覆盖了后台路由全集（否则下面的负向断言是空跑）', () => {
    // 后台有 60+ 个写入口，少扫一个就等于给漏网留了口子，所以这里对**数量**下断言
    expect(adminRoutes.length).toBeGreaterThanOrEqual(50)
    // 并且抽查几个关键入口确实在扫描范围内
    for (const key of ['admin/users/[id]/points', 'admin/users/[id]/reset-password', 'admin/invite-rewards/[id]']) {
      expect(adminRoutes.some((p) => p.includes(key))).toBe(true)
    }
  })

  it('后台路由一律不许裸写 adminActionLog.create —— 只能经 lib/admin-audit', () => {
    const src = adminRoutes.map((p) => readSource(p)).join('\n')
    assertNotMatches(
      src,
      /prisma\.adminActionLog\.create|tx\.adminActionLog\.create/,
      '留痕必须走 lib/admin-audit 的唯一入口，否则新增接口照样会漏',
      "from '@/lib/admin-audit'",
    )
  })

  it('留痕实现只有一处，且它自己就是唯一的 create 调用点', () => {
    // 只数代码，不数注释：这份文件的头注释里就引用了 `prisma.adminActionLog.create` 两次，
    // 按原文计数会得到 3，守卫会因为「有人在文档里提了一句」而莫名变红。
    const code = readSource('src/lib/admin-audit.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n')
    expect(code.match(/adminActionLog\.create/g) || []).toHaveLength(1)
  })

  it('删除账号的留痕指向被删用户，身份写进 note（不再是编码进 action 的临时绕法）', () => {
    const impl = readSource('src/app/api/admin/users/[id]/route.ts')
    assertNotMatches(impl, /action: `delete_user:\$\{id\}/, '动作码必须可统计；被删者身份属于 note，不属于 action', "action: 'delete_user'")
  })

  /**
   * 这张表就是「本轮为什么只覆盖到 15 个入口」的诚实交代。
   *
   * 剩下的后台写路由**没有一个能写留痕**：`admin_action_logs.user_id` 是 NOT NULL，
   * 而改充值档位 / 改模型密钥 / 发卡密 这类操作**不存在「被操作的用户」**。
   * 硬塞就得把 adminId 填进 userId —— 那正是旧 `delete_user:${id}:${phone}` 的污染写法，
   * 会让这张表从此没法按动作统计。真正的解法要动库结构（放开 `user_id` 可空 +
   * 加 `target_kind`），已登记为 **Q-D54**，按 `docs/DEPLOY_RUNBOOK.md` 先备份再改。
   *
   * 这条断言的作用是**只减不增**：新增一个后台写接口时，要么接留痕，
   * 要么把它加进这张表 —— 后者会在 diff 里被看见，而不是像过去那样静默漏掉。
   * （同 Q-D30 元守卫的例外表口径。）
   */
  const AUDIT_PENDING_SCHEMA = [
    'adapters/parse/route.ts',
    'adapters/route.ts',
    'adapters/[id]/route.ts',
    'agent-config/route.ts',
    'announcements/route.ts',
    'announcements/[id]/route.ts',
    'assets-cleanup/route.ts',
    'canvas-nodes/route.ts',
    'canvas-nodes/sync-builtin/route.ts',
    'canvas-nodes/[id]/route.ts',
    'card-keys/route.ts',
    'free-quota/route.ts',
    'invite-policy/route.ts',
    'models/route.ts',
    'models/[id]/route.ts',
    'prompt-sources/pull-all/route.ts',
    'prompt-sources/route.ts',
    'prompt-sources/[id]/pull/route.ts',
    'prompt-sources/[id]/route.ts',
    'prompts/[id]/official/route.ts',
    'prompts/[id]/route.ts',
    'providers/route.ts',
    'providers/[id]/route.ts',
    'providers/[id]/test/route.ts',
    'smtp-config/route.ts',
    'surveys/route.ts',
    'surveys/[id]/route.ts',
    'tools/cover/route.ts',
    'verification-policy/route.ts',
  ]

  it('未接留痕的后台写路由必须逐一登记在豁免表里（只减不增，等 Q-D54 收口）', () => {
    const missing = adminRoutes.filter((p) => {
      const src = readSource(p)
      const isWrite = /^export const (POST|PUT|PATCH|DELETE) = /m.test(src)
      return isWrite && !src.includes("@/lib/admin-audit")
    }).map((p) => p.replace('src/app/api/admin/', ''))

    // 锚点：豁免表与扫描结果必须**互相吻合**，两边任一变动都会变红
    expect(new Set(missing)).toEqual(new Set(AUDIT_PENDING_SCHEMA))
    expect(missing.length).toBeGreaterThan(0) // 归零说明全量接入，此时应删掉这张表并升级为硬断言
  })
})
