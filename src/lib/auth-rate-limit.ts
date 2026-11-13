import { getPrisma } from './prisma'

/**
 * 认证爆破限流的**持久化**实现（计划 3.3 / 台账 Q-D21、Q-D19 的加固）。
 *
 * 为什么只有认证类需要落库：内存限流在容器重启/升级后清零，攻击者只要赶在发版窗口
 * 或让服务重启一次就能重置配额 —— 「登录 5 次/15 分钟」「验证码 8 次/10 分钟」
 * 这两道防线因此可被绕过。其余限流（发码频率、兑换、下单）防的是滥用/刷量而非爆破，
 * 重启清零影响可接受，继续用 `lib/rate-limit.ts` 的内存版。
 *
 * **语义与内存版的关键区别：只统计失败次数**。
 * 旧实现把成功登录也计入 5 次配额，正常用户连输错几次就把自己锁在门外；
 * 落库后这个缺陷会从「15 分钟」放大成「重启也不清零」，必须改成：
 *   - `peekAuthRateLimit`：请求前只读判定，不计数
 *   - `recordAuthFailure`：仅在凭据错误 / 验证码错误时计一次
 *   - `clearAuthFailures`：成功即清空本窗口计数（自愈，打字错误不该留尾账）
 *
 * 表：复用既有 `rate_limits`（唯一键 [ip, action, windowAt]）。这里 `ip` 列承载
 * 「限流主体标识」（IP 或账号键，由 subject 传入），`action` 区分场景。
 * 过窗口的旧行由 `lib/maintenance.ts` 定期清理，不会无限增长。
 *
 * 失败降级：DB 异常时**放行**并告警 —— 限流自身故障绝不能锁死正常登录。
 */

export interface AuthRateResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

function windowOf(windowMs: number): { windowAt: Date; resetAt: number } {
  const now = Date.now()
  const start = Math.floor(now / windowMs) * windowMs
  return { windowAt: new Date(start), resetAt: start + windowMs }
}

/**
 * 「表不存在」必须和「瞬时 DB 抖动」区分开：前者是配置缺失，
 * 若一并静默放行，会得到一个「看起来有防护、实际完全不限流」的假象。
 */
function describeFallbackError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/no such table/i.test(msg)) {
    return `限流表缺失（rate_limits 未建）—— 爆破防护当前不生效，请执行 prisma 同步并跑 scripts/ops/check-rate-limit-table.cjs 预检。原始错误: ${msg}`
  }
  return msg
}

/** 只读判定：当前窗口失败次数是否已达上限。 */
export async function peekAuthRateLimit(
  subject: string,
  action: string,
  config: { windowMs: number; maxRequests: number },
): Promise<AuthRateResult> {
  const { windowAt, resetAt } = windowOf(config.windowMs)
  try {
    const prisma = await getPrisma()
    const row = await prisma.rateLimit.findUnique({
      where: { ip_action_windowAt: { ip: subject, action, windowAt } },
      select: { count: true },
    })
    const count = row?.count ?? 0
    return { allowed: count < config.maxRequests, remaining: Math.max(0, config.maxRequests - count), resetAt }
  } catch (err) {
    console.error('[auth-rate-limit] 限流读取失败（放行，不阻断登录）:', describeFallbackError(err))
    return { allowed: true, remaining: config.maxRequests, resetAt }
  }
}

/** 记一次失败：条件递增，本窗口无行则建窗；唯一键冲突按并发首次兜底再递增一次。 */
export async function recordAuthFailure(
  subject: string,
  action: string,
  config: { windowMs: number; maxRequests: number },
): Promise<void> {
  const { windowAt } = windowOf(config.windowMs)
  const key = { ip: subject, action, windowAt }
  try {
    const prisma = await getPrisma()
    // 只给「未超限」的行计数，超限后继续累加没有意义（且会把 count 推成天文数字）
    const bumped = await prisma.rateLimit.updateMany({
      where: { ...key, count: { lt: config.maxRequests } },
      data: { count: { increment: 1 } },
    })
    if (bumped.count > 0) return

    const existing = await prisma.rateLimit.findUnique({ where: { ip_action_windowAt: key }, select: { count: true } })
    if (existing) return // 已达上限，保持计数不再增长

    try {
      await prisma.rateLimit.create({ data: { ...key, count: 1 } })
    } catch {
      // 并发首次：别的请求刚建了同一窗口行，再条件递增一次兜底
      await prisma.rateLimit.updateMany({
        where: { ...key, count: { lt: config.maxRequests } },
        data: { count: { increment: 1 } },
      })
    }
  } catch (err) {
    console.error('[auth-rate-limit] 失败计数写入异常:', describeFallbackError(err))
  }
}

/** 成功即清空本窗口失败计数（打字错误不该留尾账）。 */
export async function clearAuthFailures(subject: string, action: string, windowMs: number): Promise<void> {
  const { windowAt } = windowOf(windowMs)
  try {
    const prisma = await getPrisma()
    await prisma.rateLimit.deleteMany({ where: { ip: subject, action, windowAt } })
  } catch (err) {
    console.error('[auth-rate-limit] 失败计数清理异常:', describeFallbackError(err))
  }
}
