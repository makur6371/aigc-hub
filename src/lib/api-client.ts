import { handle401 } from './auth-client'

export interface ApiFetchOptions extends RequestInit {
  params?: Record<string, string | number | undefined>
  /** true: 401 时不触发全局跳登录（用于匿名可浏览页的后台状态恢复调用） */
  silent401?: boolean
}

export async function apiFetch<T = unknown>(
  url: string,
  options: ApiFetchOptions = {}
): Promise<{ success: boolean; data: T | null; message?: string }> {
  const { params, headers, silent401, ...rest } = options
  let fullUrl = url
  if (params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      qs.set(k, String(v))
    }
    if (qs.toString()) fullUrl += `${url.includes('?') ? '&' : '?'}${qs.toString()}`
  }

  // FormData 上传必须**让浏览器自己设 Content-Type**（它要带 boundary）——
  // 无条件写 `application/json` 会把 multipart 请求体发成非法格式，服务端解析不出文件。
  // 原先这里没有这个分支，于是所有上传调用点只能绕过 apiFetch 用裸 fetch，
  // 连带丢掉 401 → 跳登录的统一处理（Q-810 的根因之一）。
  const isFormData = typeof FormData !== 'undefined' && rest.body instanceof FormData

  let res: Response
  try {
    res = await fetch(fullUrl, {
      credentials: 'include',
      headers: {
        // FormData 时**不设** Content-Type；其余保持 JSON
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(headers || {}),
      },
      ...rest,
    })
  } catch {
    // 网络层失败（离线 / 服务重启 / DNS）——fetch 直接 reject。
    // 这里必须自己吞掉并返回同形状结果：否则所有 `void apiFetch(...)` 调用点
    // 都会变成 unhandled rejection，在浏览器里弹控制台错误、也可能被
    // Next 的错误边界接住。网络失败与「请求失败」对调用方应是同一件事。
    return { success: false, data: null, message: '网络异常，请检查连接后重试' }
  }

  let body: { message?: string; success?: boolean; data?: unknown } | null
  const text = await res.text()
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!res.ok) {
    const message = body?.message || `请求失败 (${res.status})`
    if (res.status === 401 && !silent401 && typeof window !== 'undefined') {
      handle401()
    }
    // 失败时保留响应体的 data：有些接口会用「HTTP 4xx + data 带结构化业务信息」
    // 表达「这不是失败，而是另一种路径」。典型是 /api/wx/verify 未注册时返回
    // 404 + { needsRegister: true }，调用方靠它决定跳注册页而不是报错。
    // 以前这里一律返回 data: null，导致调用方的判断恒为假、分支进不去。
    return { success: false, data: (body?.data ?? null) as T | null, message }
  }

  return {
    success: body?.success ?? true,
    data: (body?.data ?? body) as T | null,
    message: body?.message,
  }
}
