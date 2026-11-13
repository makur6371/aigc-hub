import { AsyncLocalStorage } from 'node:async_hooks'

// ===== 上游并发闸门（全平台共享）=====
//
// 把两件不同的事拆开——这是本模块存在的核心原因：
//
//   1) 派发速率（令牌桶）：每秒最多「发出」多少个新请求。
//      作用：防止批量任务在同一瞬间打出尖峰（上游虽然能扛，但瞬时尖峰没有意义）。
//
//   2) 在途上限（信号量）：同时「等待上游返回」的请求数上限。
//      作用：保护我们自己的资源（每个在途请求占 1~2 个 socket = fd）。
//
// 为什么必须拆开：早期实现只有一个计数器，从「派发」一直占到「结果返回」，
// 于是「每秒发几个」和「同时等几个」被绑成同一个数（12）。结果是
// 一张图要等 40 秒，12 个名额就被占满 40 秒，第 13 个只能干等——
// 吞吐被压到「12 / 平均耗时」，而实际上我们完全能同时等几百个。
//
// 现在的语义：**派发按速率节流，等待不设小上限**。
//   10 个批量任务 → 1 秒内按 20/秒 的节奏陆续发出 → 全部进入「等待返回」→ 谁先回来谁先出图。
//
// 两个值都可用环境变量调，无需改代码：
//   TOOL_DISPATCH_RATE  默认 20  （每秒最多派发多少个新请求）
//   TOOL_MAX_INFLIGHT   默认 300 （同时在途上限）
//
// 容量依据（实测 2026-09-14）：
//   - 本机 2 核 / 1.9G：生图是「等网络」，容器 CPU 峰值 ~6%、内存 ~145MB；
//   - 每在途请求约 1~2 fd，容器 fd 上限已提到 65535 → 300 在途余量充足；
//   - SQLite 已切 WAL + busy_timeout=5000 → 并发写不再锁全库。

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 每秒最多派发的新请求数 */
export const DISPATCH_RATE = readInt('TOOL_DISPATCH_RATE', 20, 1, 1000)
/** 同时在途（等待上游返回）上限 */
export const MAX_INFLIGHT = readInt('TOOL_MAX_INFLIGHT', 300, 1, 5000)
/**
 * 单用户在途上限（Q-D51）：防止单用户批量任务占满全平台在途名额饿死其他人。
 * 取值逻辑：全平台上限的一部分（默认 1/3），且不小于 5（单人正常工具页批量 ≤ 9 张
 * 不能被误伤）。可用 USER_MAX_INFLIGHT 覆盖；0 = 关闭用户级限制（保持旧行为）。
 */
export const USER_MAX_INFLIGHT = readInt('USER_MAX_INFLIGHT', Math.max(5, Math.floor(MAX_INFLIGHT / 3)), 0, MAX_INFLIGHT)

/** 在途上限（供 UI/日志展示） */
export function inflightLimit(): number {
  return MAX_INFLIGHT
}

/**
 * 令牌桶：控制「派发速率」。
 * 容量 = 每秒速率（允许 1 秒的突发），按时间匀速补充。
 */
function createTokenBucket(ratePerSec: number): { take: () => Promise<void> } {
  const capacity = Math.max(1, ratePerSec)
  let tokens = capacity
  let last = Date.now()

  const refill = () => {
    const now = Date.now()
    const elapsed = (now - last) / 1000
    if (elapsed <= 0) return
    tokens = Math.min(capacity, tokens + elapsed * ratePerSec)
    last = now
  }

  const take = async (): Promise<void> => {
    for (;;) {
      refill()
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      // 还差多少 token，就等多久（至少 10ms，避免忙等）
      const need = (1 - tokens) / ratePerSec
      await new Promise((r) => setTimeout(r, Math.max(10, Math.ceil(need * 1000))))
    }
  }

  return { take }
}

const dispatchBucket = createTokenBucket(DISPATCH_RATE)

/**
 * 在途信号量：限制同时在途的请求数，超出部分 FIFO 等待（不是拒绝）。
 * 进程级——同一进程内所有入口（工具箱 / 画布 / Copilot / Agent）共享额度。
 */
export function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []

  const release = () => {
    // 直接把名额「传递」给队首 waiter，而不是先 active-- 再唤醒。
    // 否则 release 与 waiter 恢复之间有一个事件循环的空档，新来的 limit() 会看到
    // active < max 直接抢占 —— 插队，队首 waiter 反而继续等（饥饿）。
    // 传递语义下 active 不变（名额从完成者手里直接交出去），队列严格 FIFO。
    const next = waiters.shift()
    if (next) next()
    else active--
  }

  const limit = async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    // 被唤醒时名额已由 release() 传递过来，不能再 ++（否则计数会漂移）
    else {
      active++
    }
    try {
      return await fn()
    } finally {
      release()
    }
  }

  limit.stats = () => ({ active, queued: waiters.length, max })
  return limit
}

/** 全平台在途闸门：所有打上游的调用都走这里 */
export const inflightLimiter = createLimiter(MAX_INFLIGHT)

// ===== 相位上报（供前端展示「等待派发 → 生成中」三段式）=====
//
// 闸门深处并不知道「这次调用属于哪个运行 / 哪个节点」，所以用 AsyncLocalStorage
// 把调用方的上报器透传进来：调用方（画布执行器）在跑某个节点前 run 一个上报器，
// 之后该节点内部任何打上游的调用都会命中同一个上报器。
//
//   queued  —— 还没拿到派发令牌 / 在途名额，正在排队（前端显示「等待派发」）
//   running —— 已发出，等待上游返回（前端显示「生成中 + 计时」）
export type GatePhase = 'queued' | 'running'

const phaseStore = new AsyncLocalStorage<(phase: GatePhase) => void>()
/** 用户级在途闸门：按 userId 分桶（不传 userId 的调用不占用户名额） */
const userLimiters = new Map<string, ReturnType<typeof createLimiter>>()

/**
 * 在 fn 执行期间绑定一个相位上报器。
 * fn 内部所有 withUpstreamGate 调用都会把 queued/running 通知给它。
 */
export function withGatePhaseReporter<T>(
  reporter: (phase: GatePhase) => void,
  fn: () => Promise<T>,
): Promise<T> {
  return phaseStore.run(reporter, fn)
}

function userLimiterOf(userId: string) {
  let limiter = userLimiters.get(userId)
  if (!limiter) {
    limiter = createLimiter(USER_MAX_INFLIGHT)
    userLimiters.set(userId, limiter)
  }
  return limiter
}

/** 当前闸门状态（供排队提示 / 运维观测） */
export function gateStats(): { active: number; queued: number; max: number; ratePerSec: number } {
  const s = inflightLimiter.stats()
  return { ...s, ratePerSec: DISPATCH_RATE }
}

/** 用户级闸门状态（运维观测：每用户的在途/排队） */
export function userGateStats(): Array<{ userId: string; active: number; queued: number; max: number }> {
  return [...userLimiters.entries()].map(([userId, limiter]) => {
    const s = limiter.stats()
    return { userId, active: s.active, queued: s.queued, max: s.max }
  })
}

/**
 * 统一入口：先按速率拿派发令牌，再占在途名额，然后执行。
 *
 * 调用方（provider-invoker）只需把「真正打上游的那一段」包进来即可；
 * 排队等待发生在这里，不会占用调用方的任何资源。
 */
export async function withUpstreamGate<T>(fn: () => Promise<T>, userId?: string): Promise<T> {
  const report = phaseStore.getStore()
  // 进入闸门即视为「等待派发」：先等速率令牌，再等在途名额，两者都拿到才算真正发出
  report?.('queued')
  await dispatchBucket.take()
  // 用户级在途限制：在全平台名额内再按用户分桶（USER_MAX_INFLIGHT=0 时关闭）。
  // 单用户超限时只排自己的队，不占用平台名额（等待发生在自己的桶里）。
  if (userId && USER_MAX_INFLIGHT > 0) {
    return userLimiterOf(userId)(async () => {
      report?.('running')
      return fn()
    })
  }
  return inflightLimiter(async () => {
    report?.('running')
    return fn()
  })
}
