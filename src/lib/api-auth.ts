import { NextRequest } from 'next/server'
import { verifyToken, type JWTPayload } from '@/lib/auth'

export async function getAuthUser(request: NextRequest): Promise<JWTPayload | null> {
  const candidates: string[] = []
  // 收集所有同名 token cookie(旧登录页写过非 httpOnly 副本,可能多个并存),逐个验签取第一个有效
  const cookieHeader = request.headers.get('cookie')
  if (cookieHeader) {
    for (const m of cookieHeader.matchAll(/(?:^|;\s*)token=([^;]+)/g)) {
      candidates.push(decodeURIComponent(m[1]))
    }
  }
  const authHeader = request.headers.get('authorization')?.replace('Bearer ', '')
  if (authHeader) candidates.push(authHeader)
  const cookieToken = request.cookies.get('token')?.value
  if (cookieToken) candidates.push(cookieToken)

  for (const token of candidates) {
    if (!token) continue
    // verifyToken 内含真验签 + 过期校验，无效副本静默换下一个
    const payload = verifyToken(token)
    if (payload) return payload
  }
  return null
}
