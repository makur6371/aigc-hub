import { beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionCookieOptions, signSessionToken, verifyToken } from '@/lib/auth'
import { readSource } from './helpers/source-guard'

/**
 * 会话撤销（Q-506）：JWT 无状态，签发后 7 天内不变 ——
 * 没有版本号就没法在「改密码 / 管理员重置密码」时踢掉已泄露的会话。
 *
 * 这里锁两件事：
 *  1. **签发只能走 signSessionToken**：新登录方式若自己 jwt.sign 就会漏掉 tv，
 *     而漏掉的后果（改密踢不掉旧会话）不会报错，只有出事时才看得见；
 *  2. 两处凭据变更入口都必须递增 tokenVersion。
 */

beforeAll(() => {
  // 测试环境不加载 .env，getJwtSecret 会 fail-fast —— 给一个仅供测试的强密钥
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-secret-please-never-use-in-prod-0123456789'
})

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkTs(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('signSessionToken', () => {
  it('签出的 token 带 tv，并能被 verifyToken 原样读回', () => {
    const token = signSessionToken({ id: 'u1', phone: ('138' + '00000000'), role: 'USER', tokenVersion: 7 })
    const payload = verifyToken(token)
    expect(payload?.userId).toBe('u1')
    expect(payload?.tv).toBe(7)
  })

  it('缺 tokenVersion 时按 0 签发（老库数据/迁移期不为 null）', () => {
    const payload = verifyToken(signSessionToken({ id: 'u2', phone: null, role: 'USER' }))
    expect(payload?.tv).toBe(0)
  })

  it('cookie 属性齐备：httpOnly + 生产 secure + lax + 与 token 同为 7 天', () => {
    const opts = sessionCookieOptions()
    expect(opts.httpOnly).toBe(true)
    expect(opts.sameSite).toBe('lax')
    expect(opts.maxAge).toBe(60 * 60 * 24 * 7)
    expect(opts.secure).toBe(process.env.NODE_ENV === 'production')
  })
})

describe('会话签发与撤销入口（源码守卫）', () => {
  it('锚点自检：确实扫到了 API 路由（否则下面几条会静默空跑）', () => {
    const files = walkTs('src/app/api')
    expect(files.length).toBeGreaterThan(100)
  })

  it('API 路由里不再出现裸 jwt.sign（必须用 signSessionToken）', () => {
    const offenders = walkTs('src/app/api')
      .filter((f) => /jwt\.sign\s*\(/.test(readSource(f)))
    expect(offenders, `这些路由自己签 token，会漏掉 tv：${offenders.join(', ')}`).toEqual([])
  })

  it('用户改密与管理员重置都递增 tokenVersion', () => {
    for (const f of ['src/app/api/user/change-password/route.ts', 'src/app/api/admin/users/[id]/reset-password/route.ts']) {
      expect(readSource(f), `${f} 忘记递增 tokenVersion（旧会话将仍然有效）`).toContain('tokenVersion: { increment: 1 }')
    }
  })

  it('proxy 比对版本时用的是同一次账号查询（不额外多查一次库）', () => {
    const src = readSource('src/proxy.ts')
    expect(src).toContain('tokenVersion: true')
    expect(src).toContain('payload.tv ?? 0')
    // 账号查询仍只有一次
    expect(src.match(/prisma\.user\.findUnique/g)?.length).toBe(1)
  })
})
