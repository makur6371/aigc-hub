// MCP 鉴权层：配对码（mkp_...）→ userId。
// sha256 查表 + 过期/撤销检查；失败按 IP 限速（防爆破）。stateless 下每请求验证。

import { createHash } from 'crypto'
import { getPrisma } from '@/lib/prisma'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import { ORG } from '@/lib/site-content'
import type { AuthInfo } from '@modelcontextprotocol/server'

// ===== 频控（内存级，单实例足够；重启清零可接受） =====
interface FailRecord { count: number; firstAt: number; blockedUntil?: number }
const FAIL_WINDOW_MS = 10 * 60 * 1000 // 10 分钟窗口
const FAIL_LIMIT = 5 // 窗口内 5 次失败
const BLOCK_MS = 15 * 60 * 1000 // 封 15 分钟

const failMap = new Map<string, FailRecord>()
let lastSweepAt = 0

function sweep() {
  const now = Date.now()
  if (now - lastSweepAt < 60_000) return // 每分钟最多清一次
  lastSweepAt = now
  for (const [ip, rec] of failMap) {
    if (rec.blockedUntil && rec.blockedUntil < now) failMap.delete(ip)
    else if (!rec.blockedUntil && now - rec.firstAt > FAIL_WINDOW_MS) failMap.delete(ip)
  }
}

export function checkIpBlocked(ip: string): number | null {
  sweep()
  const rec = failMap.get(ip)
  if (rec?.blockedUntil && rec.blockedUntil > Date.now()) {
    return Math.ceil((rec.blockedUntil - Date.now()) / 1000)
  }
  return null
}

export function recordAuthFailure(ip: string) {
  sweep()
  const now = Date.now()
  const rec = failMap.get(ip)
  if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) {
    failMap.set(ip, { count: 1, firstAt: now })
    return
  }
  rec.count += 1
  if (rec.count >= FAIL_LIMIT) {
    rec.blockedUntil = now + BLOCK_MS
  }
}

export function clearAuthFailures(ip: string) {
  failMap.delete(ip)
}

export function clientIp(request: Request): string {
  // 口径统一到限流的唯一实现（台账 Q-D23）：原来取 XFF **第一跳**，
  // 而第一跳是客户端可伪造的 —— 攻击者轮换 XFF 头即可绕过「失败 5 次封 IP」。
  // rate-limit 的口径是「信任 nginx 覆盖写的 X-Real-IP，否则取 XFF 最后一跳」。
  return clientIpFromHeaders(request.headers)
}

// ===== 配对码验证 =====

export interface McpAuth {
  userId: string
  pairingId: string
  pairingName: string
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : null
}

/**
 * 抛 OAuthError（withMcpAuth 会透传 description 到 401 响应体），Agent/用户能看到具体原因。
 */
function fail(message: string, status: number): never {
  void status
  throw new OAuthError(OAuthErrorCode.InvalidToken, message)
}

/**
 * 验证 Bearer 配对码；有效则返回 McpAuth，无效抛 OAuthError（401 信封带中文原因）。
 * 同时负责 lastUsedAt 节流更新（>60s 才写一次，防 SQLite 写放大）。
 */
export async function verifyPairingCode(request: Request): Promise<{ auth?: McpAuth; error?: string; status: number }> {
  const ip = clientIp(request)

  const blockedFor = checkIpBlocked(ip)
  if (blockedFor !== null) {
    fail(`尝试失败次数过多，已临时封禁，请 ${blockedFor} 秒后重试（或到个人中心重新生成配对码）`, 429)
  }

  const token = extractBearer(request)
  if (!token) {
    recordAuthFailure(ip)
    fail(`缺少 Authorization: Bearer 配对码。请到${ORG.name}个人中心「MCP 连接」生成，并在 Agent 的 MCP 配置里以 Bearer 方式填入`, 401)
  }
  if (!token.startsWith('mkp_') || token.length < 20 || token.length > 200) {
    recordAuthFailure(ip)
    fail('配对码格式不正确（应以 mkp_ 开头）。请到个人中心重新复制完整配对码', 401)
  }

  const prisma = await getPrisma()
  const pairing = await prisma.mcpPairing.findUnique({ where: { codeHash: hashCode(token) } })
  if (!pairing) {
    recordAuthFailure(ip)
    fail('配对码无效或已被删除。请到个人中心「MCP 连接」核对或重新生成', 401)
  }
  if (pairing.revokedAt) {
    fail(`配对码「${pairing.name}」已撤销。请到个人中心重新生成一个新配对码`, 401)
  }
  if (pairing.expiresAt.getTime() < Date.now()) {
    fail(`配对码「${pairing.name}」已过期。请到个人中心重新生成一个新配对码`, 401)
  }

  clearAuthFailures(ip)

  // lastUsedAt 节流更新：距上次 >60s 才写；失败吞掉（不影响主流程）
  if (!pairing.lastUsedAt || Date.now() - pairing.lastUsedAt.getTime() > 60_000) {
    await prisma.mcpPairing.update({
      where: { id: pairing.id },
      data: { lastUsedAt: new Date(), lastUsedIp: ip },
    }).catch(() => { /* SQLite 偶发锁，忽略 */ })
  }

  return {
    auth: { userId: pairing.userId, pairingId: pairing.id, pairingName: pairing.name },
    status: 200,
  }
}

/** 转 MCP SDK 的 AuthInfo（extra 里带 userId，供工具 ctx.http.authInfo 取用） */
export function toAuthInfo(auth: McpAuth, token: string): AuthInfo {
  return {
    token,
    clientId: `aigc-hub-pairing:${auth.pairingId}`,
    scopes: ['mcp:canvas'],
    extra: { userId: auth.userId, pairingName: auth.pairingName },
  }
}
