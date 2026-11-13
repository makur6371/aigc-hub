import { NextRequest } from 'next/server'

interface RateEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateEntry>()

// 惰性清理：expired 条目永不移除会在长跑服务里累积（每用户/IP 一个 key），这里周期性扫掉。
let lastCleanAt = 0
const CLEAN_INTERVAL_MS = 60_000 // 每 60s 最多做一次整理，避免频繁遍历
function pruneStore(now: number) {
  if (now - lastCleanAt < CLEAN_INTERVAL_MS) return
  lastCleanAt = now
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key)
  }
  // 防御极端增长（例如逐请求拼接的畸形 key）：上限兜底
  if (store.size > 10_000) {
    const sorted = [...store.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (const [key] of sorted.slice(0, sorted.length - 10_000)) store.delete(key)
  }
}

export interface RateLimitConfig {
  windowMs: number    // 时间窗口(毫秒)
  maxRequests: number // 窗口内最大请求数
}

/**
 * 检查是否超限。返回 { allowed, remaining, resetAt }。
 * 基于内存,单实例有效。生产环境请换 Redis。
 */
export function checkRateLimit(key: string, config: RateLimitConfig): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
  pruneStore(now)
  const entry = store.get(key)

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + config.windowMs })
    return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs }
  }

  if (entry.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: config.maxRequests - entry.count, resetAt: entry.resetAt }
}

/**
 * 从 request 提取客户端 IP。
 * 生产入口是宿主机 nginx：它会把 X-Real-IP 覆盖为真实 $remote_addr、并往 X-Forwarded-For 追加。
 * 因此优先信任 X-Real-IP（nginx 覆盖写，客户端伪造无效），XFF 只取最后一跳。
 * 注意：应用端口必须只绑定回环，否则直连可伪造这两个头绕过限流。
 */
export function getClientIp(request: NextRequest): string {
  return clientIpFromHeaders(request.headers)
}

/**
 * IP 归一化的唯一实现（限流与 MCP 失败封禁共用，避免两处口径相反）。
 * 生产入口是宿主机 nginx：它把 X-Real-IP 覆盖为真实 $remote_addr、并往 XFF 追加，
 * 所以优先信任 X-Real-IP（客户端伪造无效），XFF 取**最后一跳**（第一跳可被伪造）。
 */
export function clientIpFromHeaders(headers: Headers): string {
  const realIp = headers.get('x-real-ip')
  if (realIp && realIp.trim()) return realIp.trim()
  const fwd = headers.get('x-forwarded-for')
  if (fwd) {
    const hops = fwd.split(',').map((s) => s.trim()).filter(Boolean)
    if (hops.length > 0) return hops[hops.length - 1]
  }
  return 'unknown'
}
