import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from './api-auth'
import { errorRecord, recordError } from './error-sink'

export interface ApiSuccess<T = unknown> {
  success: true
  data: T
  message?: string
}

export interface ApiError {
  success: false
  data: null
  message: string
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError

export class ApiHandlerError extends Error {
  status: number
  constructor(public message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export async function requireAuth(
  request: NextRequest,
  opts: { admin?: boolean } = {}
): Promise<{ userId: string; phone: string | null; role: string }> {
  const user = await getAuthUser(request)
  if (!user) {
    throw new ApiHandlerError('未登录', 401)
  }
  if (opts.admin && user.role !== 'ADMIN') {
    throw new ApiHandlerError('无权限', 403)
  }
  return user
}

/**
 * 解析分页参数，**永远返回合法整数**。
 *
 * 为什么不能直接用 Math.max(1, parseInt(x, 10))：parseInt('abc') 是 NaN，
 * 而 Math.max(1, NaN) 还是 NaN —— 会把 `skip`/`take` 变成 NaN 传给 Prisma，
 * 查询直接报错。这些参数来自 URL，`?page=abc`、`?pageSize=` 都是常态，
 * 不是恶意输入也该正常回落默认值（否则一个手滑的请求就是 500）。
 */
export function toPositiveInt(raw: string | null, fallback: number, max?: number): number {
  const n = parseInt(raw ?? '', 10)
  const safe = Number.isFinite(n) ? n : fallback
  const clamped = Math.max(1, safe)
  return max == null ? clamped : Math.min(max, clamped)
}

export function parsePagination(url: URL, defaults: { page?: number; pageSize?: number; maxPageSize?: number } = {}) {
  const maxPageSize = defaults.maxPageSize ?? 100
  return {
    page: toPositiveInt(url.searchParams.get('page'), defaults.page ?? 1),
    pageSize: toPositiveInt(url.searchParams.get('pageSize'), defaults.pageSize ?? 20, maxPageSize),
  }
}

export function success<T>(data: T, message = 'ok'): NextResponse {
  return NextResponse.json({ success: true, data, message })
}

export function error(message: string, status = 500): NextResponse {
  return NextResponse.json({ success: false, data: null, message }, { status })
}

/** 请求路径尽力提取：错误处理器自身绝不能因请求对象形态（测试替身/非标准 Request）再抛 */
function safeRequestPath(req: NextRequest): string | undefined {
  try {
    return req?.nextUrl?.pathname ?? (typeof req?.url === 'string' ? new URL(req.url).pathname : undefined)
  } catch {
    return undefined
  }
}

type RouteContext<P = unknown> = { params: Promise<P> }

export function apiHandler<P = unknown>(
  fn: (req: NextRequest, ctx: { url: URL; params: Promise<P> }) => Promise<unknown> | unknown
): (req: NextRequest, routeCtx: RouteContext<P>) => Promise<NextResponse | Response> {
  return async (req: NextRequest, routeCtx: RouteContext<P>) => {
    try {
      const data = await fn(req, { url: new URL(req.url), params: routeCtx.params ?? Promise.resolve({} as P) })
      if (data instanceof Response) {
        return data
      }
      return NextResponse.json({ success: true, data, message: 'ok' })
    } catch (err) {
      const reqPath = safeRequestPath(req)
      if (err instanceof ApiHandlerError) {
        // 5xx 级业务错误（如 502 上游失败）也留痕，供重启后回查（计划 3.2）
        if (err.status >= 500) recordError(errorRecord('api', err, { path: reqPath }))
        return NextResponse.json({ success: false, data: null, message: err.message }, { status: err.status })
      }
      // 业务代码 throw new Error('业务消息') 视为客户端错误（校验/状态/未找到），
      // 保留原始 message 供前端 toast 展示；只有非 Error 的未预期异常才走 500 兜底。
      // 但裸 Error 也可能是服务端真 bug（本应 500），在此统一留痕，避免"静默 400 无日志"难排障。
      if (err instanceof Error && err.message) {
        console.error('[apiHandler] 业务路由抛裸 Error(按 400 返回)。建议改用 ApiHandlerError(msg, status):', err.message, '\n', err.stack)
        // 裸 Error 可能是真 bug 被降级成 400 —— 落盘以便事后识别（不改返回语义）
        recordError(errorRecord('api-bare-error', err, { path: reqPath }))
        return NextResponse.json({ success: false, data: null, message: err.message }, { status: 400 })
      }
      console.error('[apiHandler] unhandled error:', err)
      recordError(errorRecord('api-unhandled', err, { path: reqPath }))
      return NextResponse.json({ success: false, data: null, message: '服务器内部错误' }, { status: 500 })
    }
  }
}
