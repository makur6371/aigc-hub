import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifyToken, verifyAdmin } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { LOW_BLOCKED_PREFIXES, hitsAny } from '@/lib/api-policy'

const PUBLIC_PATHS = ['/', '/login', '/faq', '/model-pricing', '/gallery', '/tools', '/create', '/api/auth/login', '/api/auth/logout']
// 公开作品 / 提示词详情、公开只读 API：GET 放行
// /api/mcp 自验 Bearer 配对码（route 内查库），不走会话闸门
// /api/tool-cover/ 是工具封面（平台展示资产，公网可读）——工具箱列表是公开页，未登录也要能看图
// /api/cover 是**公开图片中转**（带 SSRF 校验 + 磁盘缓存 + 并发去重），不是敏感接口：
// 它只做「把公网图片拉回来并缓存」这一件事，任何人都能用（工具箱列表/作品广场的封面本来就公开）。
// 之前漏了它 → 未登录/会话过期时返回 401 → 前端代理链路整条失效、静默回落直连重下，
// 表现就是「成果区已经显示出来了，点进工作台还要再等一次」。
const PUBLIC_PREFIXES = ['/_next/', '/favicon.ico', '/logo', '/placeholder.png', '/demo/', '/api/demo/', '/generated/', '/api/asset/', '/api/tool-cover/', '/api/cover', '/gallery/', '/api/mcp']
// 匿名可读的公开数据 API（GET，不写不敏感）：首页下滑区缺认可见作品/提示词、顶部公告横幅
const PUBLIC_READ_PREFIXES = ['/api/works', '/api/prompts', '/api/announcements', '/api/tools', '/api/models']

/** 透明放行,保留原始 request(含 cookie) */
function passHeaders() {
  return NextResponse.next()
}

// 兼容历史遗留的多个同名 token cookie(旧登录页写过非 httpOnly 副本):
// 取第一个能解出 payload 的 token,避免读到过期/垃圾副本导致误判未登录跳转 /login
function extractToken(request: NextRequest): string | null {
  const raw = request.headers.get('cookie') || ''
  const tokens = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('token='))
    .map((s) => s.slice('token='.length))
    .filter((s) => s.length > 0)
  if (tokens.length === 0) return null
  for (const t of tokens) {
    if (verifyToken(t)) return t
  }
  return tokens[0] ?? null
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.includes(pathname) || pathname.startsWith('/tools/') || pathname.startsWith('/create/')) {
    return passHeaders()
  }

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return passHeaders()
  }

  // 公开只读 API：仅 GET 放行（POST/PUT 仍需登录以保护写权限）
  if (request.method === 'GET' && PUBLIC_READ_PREFIXES.some((p) => pathname.startsWith(p))) {
    return passHeaders()
  }

  const token = extractToken(request)

  // 后台路径：**只校验 JWT 里的角色**（快），通过后不立即放行 ——
  // 还要走下面的「账号状态实时校验」比对库中 role/status，否则降权/冻结不生效。
  // 这里刻意不 return，让流程继续往下走（历史 bug：此处提前 return 导致实时校验形同虚设）。
  const isAdminPathEarly = pathname.startsWith('/admin') || pathname.startsWith('/api/admin')
  if (isAdminPathEarly) {
    if (!token || !verifyAdmin(token)) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ success: false, data: null, message: '无权限' }, { status: 401 })
      }
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('redirect', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }

  // All other routes (pages and non-admin APIs) require a valid session.
  if (!token || !verifyToken(token)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ===== 账号状态实时校验（一次查询覆盖四项）=====
  //
  // 为什么必须查库：JWT 无状态，签发后 7 天内内容不变。于是有两个真实缺口：
  //   1) 管理员冻结用户 → 对方已登录会话照常可用，要等 token 过期才生效（冻结形同虚设）；
  //   2) 管理员撤销 ADMIN → 旧 token 里仍是 ADMIN，仍能访问全部后台接口。
  // 两者都是「违规处置不生效」，属实质性问题（INV-2026-0919-01 的 A-01/A-02）。
  //
  // 实现要点：
  //   - 只查一次：原来两个分支各查一次且各只取一个字段，合并后总查询次数不增反减；
  //   - 主键查询 + 只 select 4 个字段，单机 SQLite 成本极低；
  //   - 账号不存在（已删除）→ 按未授权处理，不给残留 token 留口子；
  //   - 查询异常放行（避免数据库抖动导致全站不可用），与原「避免误杀」口径一致。
  const needsSecurityCheck = hitsAny(pathname, LOW_BLOCKED_PREFIXES)
  const isAdminPath = pathname.startsWith('/admin') || pathname.startsWith('/api/admin')

  // 注意：冻结校验必须覆盖**所有已登录请求**，不能只覆盖消耗性接口与后台路径 ——
  // 否则被冻结用户仍能调 /api/user/profile 等接口（实测发现过）。
  // 代价是每个已登录请求多一次主键查询；单机 SQLite 下这是可接受的（也是 A-01 的修复前提）。
  {
    try {
      const payload = verifyToken(token)
      if (!payload) return passHeaders()
      const prisma = await getPrisma()
      const account = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { phone: true, securityLevel: true, status: true, role: true, tokenVersion: true },
      })
      // 账号不存在（已删除）：会话立即失效
      if (!account) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ success: false, message: '账号不存在，请重新登录' }, { status: 401 })
        }
        const gone = new URL('/login', request.url)
        gone.searchParams.set('redirect', pathname)
        return NextResponse.redirect(gone)
      }
      // 冻结：实时生效（不再等 7 天 token 过期）
      if (account.status === 'FROZEN') {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ success: false, message: '账号已被冻结，请联系站点管理员' }, { status: 403 })
        }
        return NextResponse.redirect(new URL('/login', request.url))
      }
      // 凭据变更：改密码 / 管理员重置密码 → tokenVersion 变化 → 旧 token 立即失效（Q-506）。
      // 历史 token 没有 tv，按 0 处理，与库里默认值一致，不会在上线瞬间踢掉在线用户。
      if ((payload.tv ?? 0) !== account.tokenVersion) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ success: false, message: '登录状态已失效，请重新登录' }, { status: 401 })
        }
        const stale = new URL('/login', request.url)
        stale.searchParams.set('redirect', pathname)
        return NextResponse.redirect(stale)
      }

      // 管理员降权：实时生效 —— token 里写着 ADMIN 但库里已不是 → 拒绝后台访问
      if (isAdminPath && payload.role === 'ADMIN' && account.role !== 'ADMIN') {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ success: false, message: '无权限' }, { status: 403 })
        }
        const denied = new URL('/login', request.url)
        denied.searchParams.set('redirect', pathname)
        return NextResponse.redirect(denied)
      }
      // LOW 安全等级：拦截消耗性 API
      if (needsSecurityCheck && account.securityLevel === 'LOW') {
        return NextResponse.json(
          { success: false, message: '当前账号安全等级较低,该功能已锁定。请联系管理员完成人工核验解锁。' },
          { status: 403 }
        )
      }
    } catch { /* 查询失败放行，避免误杀 */ }
  }

  return passHeaders()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
}
