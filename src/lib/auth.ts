import jwt from 'jsonwebtoken'
import type { UserRole } from '@/types'

export interface JWTPayload {
  userId: string
  phone: string | null
  role: UserRole
  /**
   * 会话版本号（台账 Q-506）。**可选**是刻意的：加字段前签发的历史 token 没有它，
   * 校验时按 0 处理（库里默认值也是 0），避免上线瞬间把全体在线用户踢下线。
   */
  tv?: number
}

/**
 * 签发会话 token 的唯一入口。
 *
 * 为什么不让各登录口自己 jwt.sign：凭据失效要能作废旧会话，靠的是把
 * `users.tokenVersion` 签进 token；漏签一次的后果是「改完密码旧 token 照样能用 7 天」，
 * 而这种缺陷不会报错，只有出事时才看得见。收成一个函数，新增登录方式自动带上。
 */
export function signSessionToken(
  user: { id: string; phone: string | null; role: string; tokenVersion?: number },
): string {
  return jwt.sign(
    { userId: user.id, phone: user.phone, role: user.role, tv: user.tokenVersion ?? 0 },
    getJwtSecret(),
    { expiresIn: '7d' },
  )
}

/**
 * 获取 JWT 密钥。缺失时直接抛错（fail-fast）：
 * 弱密钥等于全站鉴权裸奔（任何人都可自签合法 token），宁可不启动。
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET 未配置：请在环境变量中设置强密钥后再启动服务')
  }
  return secret
}

/** 真验签 + 过期校验。签名不对 / 已过期 / 格式非法 一律返回 null */
export function verifyToken(token: string): JWTPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret())
    if (payload && typeof payload === 'object' && (payload as JWTPayload).userId) {
      return payload as JWTPayload
    }
    return null
  } catch {
    return null
  }
}

/** 是否为有效 ADMIN token（验签 + 过期 + 角色） */
export function verifyAdmin(token: string): boolean {
  const payload = verifyToken(token)
  return payload?.role === 'ADMIN'
}

/**
 * 会话 cookie 的统一属性（登录和改密换发共用）。
 *
 * 为什么收成函数：`httpOnly`、生产 `secure`、`sameSite: lax` 这几项任何一处写漏，
 * 就是「token 可被 JS 读取」或「生产走明文」这种只在出事时才可见的缺陷。
 * 与 signSessionToken 配套：签发与投递都不该各写一遍。
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.APP_ALLOW_INSECURE_HTTP !== '1',
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 7, // 与 token 的 7 天有效期对齐
    path: '/',
  }
}
