import { lookup } from 'dns/promises'
import { isIP } from 'net'

// ===== SSRF 防护（服务端代拉外部 URL 时用）=====
//
// 场景：/api/cover（封面中转）、rehostExternalAsset（上游图转存）都要服务端去 fetch
// 用户/上游给的 URL。如果不校验，攻击者可以让服务器去请求内网地址。
//
// 最危险的不是 127.0.0.1，而是**云元数据地址 169.254.169.254** ——
// 在腾讯云/AWS/GCP 上命中就能拿到实例凭证（相当于拿到服务器权限）。
//
// 校验策略（两层）：
//   1) 字面量校验：hostname 直接是 IP，或形如 2130706433（十进制）/ 0x7f000001（十六进制）
//   2) DNS 解析后校验：域名解析出的**每一个** IP 都要合法（防 DNS rebinding 到内网）

/** 判断 IPv4 是否属于禁止访问的网段 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0) return true                          // 0.0.0.0/8
  if (a === 10) return true                         // 10/8 私有
  if (a === 127) return true                        // 127/8 回环
  if (a === 169 && b === 254) return true           // 169.254/16 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true  // 172.16/12 私有
  if (a === 192 && b === 168) return true           // 192.168/16 私有
  if (a === 192 && b === 0) return true             // 192.0.0/24、192.0.2/24 保留
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试
  if (a >= 224) return true                         // 224/4 组播 + 240/4 保留
  return false
}

/** 判断 IPv6 是否属于禁止访问的网段 */
function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0] // 去掉 zone id
  if (s === '::' || s === '::1') return true
  // IPv4-mapped 有两种写法，都要按 IPv4 规则再判一次：
  //   ::ffff:127.0.0.1（点分）  和  ::ffff:7f00:1（十六进制）
  // 后者是 `new URL('http://[::ffff:127.0.0.1]/')` 规范化后的形式 —— 只认点分会漏。
  const mappedDotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedDotted) return isBlockedIPv4(mappedDotted[1])
  const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    const ipv4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
    return isBlockedIPv4(ipv4)
  }
  if (s.startsWith('fe80')) return true   // 链路本地
  if (s.startsWith('fc') || s.startsWith('fd')) return true // 唯一本地
  if (s.startsWith('ff')) return true     // 组播
  return false
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isBlockedIPv4(ip)
  if (v === 6) return isBlockedIPv6(ip)
  return true // 认不出来的一律拒绝
}

/** 把十进制/十六进制/八进制形式的 IP 还原成点分十进制（浏览器和 fetch 都认这些写法） */
function normalizeNumericHost(host: string): string | null {
  // 2130706433 → 127.0.0.1
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  // 0x7f000001 → 127.0.0.1
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  return null
}

export interface SsrfCheckResult {
  ok: boolean
  reason?: string
}

/**
 * 是否启用「DNS 解析后校验」。
 *
 * 字面量 IP / 内网主机名的校验**永远开启**（零误杀风险）。
 * 但解析后校验在部分环境会误杀：本机开发时 Clash 等代理会把所有域名解析成
 * 198.18.0.0/15 的 fake-IP；少数运营商 DNS 也会把域名劫持到保留段。
 * 生产是容器直连外网（无代理），开启是安全的；如需排查可设
 * SSRF_DNS_CHECK=off 临时关掉。
 */
const DNS_CHECK_ENABLED = process.env.SSRF_DNS_CHECK !== 'off'

/**
 * 校验一个 URL 是否可以安全地由服务端请求。
 *
 * 注意：DNS rebinding 无法 100% 防住（解析与请求之间仍可能变），
 * 但「解析后校验每个 IP」已经挡掉绝大多数场景；真正的强防护需要在
 * 请求时固定 IP（Node fetch 不支持），收益不抵复杂度。
 */
export async function checkUrlSafe(rawUrl: string): Promise<SsrfCheckResult> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL 格式非法' }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: '仅支持 http/https' }
  }

  const host = target.hostname.replace(/^\[|\]$/g, '') // 去掉 IPv6 方括号

  // 1) 字面量 IP
  if (isIP(host)) {
    return isBlockedIp(host) ? { ok: false, reason: '禁止访问内网/保留地址' } : { ok: true }
  }
  // 2) 数字形式的 IP（2130706433 / 0x7f000001）
  const numeric = normalizeNumericHost(host)
  if (numeric) {
    return isBlockedIp(numeric) ? { ok: false, reason: '禁止访问内网/保留地址' } : { ok: true }
  }
  // 3) 明显的内网主机名
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    return { ok: false, reason: '禁止访问内网主机名' }
  }
  // 4) DNS 解析后逐个校验（防域名指向内网）
  if (!DNS_CHECK_ENABLED) return { ok: true }
  try {
    const addrs = await lookup(host, { all: true })
    if (addrs.length === 0) return { ok: false, reason: '域名无法解析' }
    for (const a of addrs) {
      if (isBlockedIp(a.address)) return { ok: false, reason: '域名解析到内网/保留地址' }
    }
  } catch {
    return { ok: false, reason: '域名无法解析' }
  }
  return { ok: true }
}

/**
 * 带 SSRF 防护的 fetch：校验 URL + **不自动跟随重定向**。
 *
 * 为什么不直接 checkUrlSafe 后 fetch：checkUrlSafe 只校验**原始 host**，
 * 而 fetch 默认 `redirect: 'follow'` —— 一个合法公网 URL 返回
 * `302 Location: http://169.254.169.254/...` 就能绕过全部校验（云元数据/内网）。
 * 这里对每一跳的 Location 重新校验，并限制跳数（默认 3），
 * 把「校验后重定向绕过」这条确定可复现的路径堵死。
 *
 * 覆盖点：/api/asset-proxy、/api/cover、rehostExternalAsset 等所有服务端代拉入口。
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3
  let current = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await checkUrlSafe(current)
    if (!safe.ok) throw new Error(safe.reason || '禁止访问')
    const res = await fetch(current, { ...init, redirect: 'manual' })
    // 3xx：手动解析 Location 并校验后再跟一跳
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
  throw new Error('重定向次数过多')
}
