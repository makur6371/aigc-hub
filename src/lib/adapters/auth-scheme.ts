// 鉴权策略统一解析：把 VendorProfile.auth 声明成实际请求头。
// 覆盖 Bearer / api-key-header / api-key-query / custom 四类差异。
import type { AuthScheme, AdapterConfig } from '@/types'

/**
 * 依 auth 策略返回请求头（不含 profile.headers 的静态头，静态头由 resolver 合并）。
 * 若未提供 auth，返回空对象（交由调用方默认 Bearer 兜底，行为保持不变）。
 */
export function buildAuthHeaders(scheme: AuthScheme | undefined, config: AdapterConfig): Record<string, string> {
  if (!scheme) return {}
  const key = config.apiKey || ''
  switch (scheme.type) {
    case 'bearer':
      return key ? { Authorization: `Bearer ${key}` } : {}
    case 'api-key-header':
      return key ? { [scheme.header]: key } : {}
    case 'api-key-query':
      // query 型在 auth-scheme 里无法写进 header，由 resolver 拼进 URL（见 query 说明）
      return {}
    case 'custom':
      return { ...(scheme.headers || {}) }
    default:
      return {}
  }
}

/**
 * 若 auth 是 api-key-query 型，返回应拼到 URL 的 query 片段（如 '?key=xxx'）。
 * 否则返回空字符串。
 *
 * 现状：**当前没有任何 adapter 使用 api-key-query**（已核生产库：零命中），
 * 且 buildAuthHeaders 对它返回空对象、调用方也没拼 query —— 也就是这条分支
 * 只在类型层存在，运行时不生效。保留实现是为了「将来真接 query 鉴权的网关时
 * 有落点」，但**接线前必须先在调用方拼上 authQueryString**，否则 key 不会发出去。
 * 详见 adapter-runtime 的 resolveHeaders。
 */
export function authQueryString(scheme: AuthScheme | undefined, config: AdapterConfig): string {
  if (scheme?.type === 'api-key-query') {
    return `${scheme.param}=${encodeURIComponent(config.apiKey || '')}`
  }
  return ''
}
