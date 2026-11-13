// ===== 媒体 URL 规范化：全站唯一实现 =====
//
// 为什么必须收敛：此前「上游外链 → /api/cover?u=... 同源代理」这一件事在各处写了 5 遍，
// 且守卫口径不一致（只有 2 处防「重复代理」），其中 7 处内联**完全无守卫**。
//
// 实测后果（INV-2026-0919-03 / Q-701）：
//   站内地址喂给 /api/cover 会返回 **HTTP 400**（cover 只接受 http(s) 协议），
//   因为生产库 tools 表里就有 8 条 `/api/tool-cover/xxx.png` 站内封面。
//   当时那 7 处无守卫的点恰好数据源全是外链，属「靠数据巧合不出事」。
//
// 本模块把这三种守卫合成一个并集，任何拼接封面/代理地址的地方都应调用它：
//   1. 非 http(s)（站内 /api/、/generated/、blob:、data:）→ **原样返回**，不能再套代理
//   2. 已经是代理地址（已含 /api/cover?u=）→ 原样返回，避免双重代理
//   3. 其余（外链）→ 直接返回上游原图。生成图必须保持原分辨率；
//      编辑器需要 fetch 时先直连，失败再走 /api/cover 兜底。

/** 站内地址前缀：这些是我们自己托管的，不需要也不能再过 /api/cover */
const INTERNAL_PREFIXES = ['/api/', '/generated/']

/** 浏览器临时地址：只在本会话有效，代理也没有意义 */
const EPHEMERAL_PREFIXES = ['blob:', 'data:']

/**
 * 是否为「浏览器临时产物」（blob: / data:）。
 *
 * 判定集中在这里，避免各处各写一遍 startsWith：
 * 这类地址刷新即失效，既不该持久化、也不该送去上游、更不该套代理。
 */
export function isEphemeralUrl(url: string): boolean {
  if (!url) return true
  return EPHEMERAL_PREFIXES.some((p) => url.startsWith(p))
}

/** 是否为我们自己托管的站内地址（/api/、/generated/） */
export function isInternalUrl(url: string): boolean {
  if (!url) return false
  return INTERNAL_PREFIXES.some((p) => url.startsWith(p))
}

/** 是否为完整公网地址（http/https） */
export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 把任意图片地址转成「可直接放进 `<img src>` 或 `fetch` 的地址」。
 *
 * - 站内 / 临时 / 空 → 原样返回（它们本就同源或只在本地）
 * - 已是代理 → 原样返回（防止 /api/cover?u=/api/cover?u=... 双层嵌套）
 * - 外链 → 直接上游原图。此前这里把生成图也包到 /api/cover，导致编辑器
 *   拿到的是 512px 缩略图，成果图看起来很糊。
 *
 * 这是**展示用**的统一入口；需要给上游（模型）用的绝对地址请用 toAbsoluteUrl。
 */
export function toDisplayUrl(url: string): string {
  return url
}

/** 外链走 cover 代理；站内/临时地址原样。用于封面展示和跨域下载。 */
export function toProxyUrl(url: string): string {
  if (!url || !isRemoteUrl(url)) return url
  if (url.includes('/api/cover?u=')) return url
  return `/api/cover?u=${encodeURIComponent(url)}`
}

/**
 * 外链原图走同源代理（不压缩分辨率）。
 *
 * 用途：成果缩略图、灯箱和 iframe 编辑器必须使用**同一个 URL**，
 * 否则 `<img>` 与 iframe `fetch()` 的缓存键不同，会出现「列表已经加载，
 * 点进工作台又下载一遍」。站内/临时地址原样返回。
 */
export function toAssetProxyUrl(url: string): string {
  if (!url || !isRemoteUrl(url)) return url
  if (url.startsWith('/api/asset-proxy?u=')) return url
  return `/api/asset-proxy?u=${encodeURIComponent(url)}`
}

/** 解开展示代理，拿回它包装的原始 URL；非代理地址原样返回。 */
export function unwrapMediaProxyUrl(url: string): string {
  const raw = String(url || '').trim()
  if (!raw.startsWith('/api/asset-proxy?u=') && !raw.startsWith('/api/cover?u=')) return raw
  try {
    return new URL(raw, 'https://example.invalid').searchParams.get('u') || raw
  } catch {
    return raw
  }
}

/**
 * 把站内相对地址补成**绝对公网地址**（上游服务器要能自己拉到）。
 *
 * 上游是远端服务器，它只认 `https://域名/...`：
 *   - 已绝对（http/https）→ 原样
 *   - 站内相对（以 / 开头）→ 拼 origin
 *   - blob:/data: → 无法直接给上游，返回空串表示「需要先上传」
 *
 * 注意：本函数**不上传**，只做地址拼接。blob 上传逻辑在调用方（需鉴权 + 配额）。
 *
 * @param origin 站点 origin（浏览器端传 window.location.origin；服务端传 NEXT_PUBLIC_APP_URL）
 */
export function toAbsoluteUrl(url: string, origin: string): string {
  if (!url) return ''
  if (isRemoteUrl(url)) return url
  if (url.startsWith('/')) return `${origin}${url}`
  // blob: / data: 上游拉不到，必须由调用方先上传换取站内地址
  return ''
}

/**
 * 该地址能否直接交给上游使用（无需上传）。
 *
 * 用于批量任务的前置校验：能直接用就跳过上传，省一次往返。
 */
export function isUpstreamFetchable(url: string, origin: string): boolean {
  if (!url) return false
  if (isRemoteUrl(url)) return true
  if (url.startsWith('/') && !!origin) return true
  return false
}
