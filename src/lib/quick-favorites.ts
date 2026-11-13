import { isSiteRelativePath, readLocalText, writeLocalJson } from '@/lib/local-store'

export interface QuickFavorite {
  label: string
  href: string
  addedAt: number
}

export const QUICK_FAVORITES_LS_KEY = 'aigc-hub:quick-favorites:v1'

export const QUICK_FAVORITE_PAGES = [
  { label: '首页', href: '/' },
  { label: 'Agent', href: '/agent' },
  { label: '创作', href: '/create' },
  { label: '画布', href: '/canvas' },
  { label: '工具箱', href: '/tools' },
  { label: '作品广场', href: '/gallery' },
  { label: '提示词库', href: '/prompts' },
  { label: '价格', href: '/model-pricing' },
] as const

const MAX_FAVORITES = 30

export function parseQuickFavorites(raw: string | null): QuickFavorite[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((item): QuickFavorite[] => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const label = typeof row.label === 'string' ? row.label.trim() : ''
      const href = typeof row.href === 'string' ? row.href.trim() : ''
      // 站内地址判定统一走规范层（Q-D55）：只判 startsWith('/') 会漏掉
      // **协议相对 URL**（`//evil.com` 同样以 '/' 开头，浏览器会把它当外站打开）。
      if (!label || !isSiteRelativePath(href) || seen.has(href)) return []
      seen.add(href)
      return [{
        label: label.slice(0, 40),
        href: href.slice(0, 512),
        addedAt: typeof row.addedAt === 'number' && Number.isFinite(row.addedAt) ? row.addedAt : 0,
      }]
    }).slice(0, MAX_FAVORITES)
  } catch {
    return []
  }
}

export function mergeQuickFavorite(
  list: QuickFavorite[],
  favorite: Omit<QuickFavorite, 'addedAt'>,
): { items: QuickFavorite[]; added: boolean } {
  const href = favorite.href.trim()
  const label = favorite.label.trim()
  if (!isSiteRelativePath(href) || !label) return { items: list, added: false }
  if (list.some((item) => item.href === href)) return { items: list, added: false }
  return {
    items: [{ label: label.slice(0, 40), href: href.slice(0, 512), addedAt: Date.now() }, ...list].slice(0, MAX_FAVORITES),
    added: true,
  }
}

export function readQuickFavorites(): QuickFavorite[] {
  if (typeof window === 'undefined') return []
  // 走规范层（Q-D55）：读取永不抛错，形状不对就回落到空列表
  return parseQuickFavorites(readLocalText(QUICK_FAVORITES_LS_KEY))
}

export function writeQuickFavorites(items: QuickFavorite[]): void {
  if (typeof window === 'undefined') return
  // 写失败（隐私模式/配额满）不阻断收藏操作 —— 与规范层的约定一致
  writeLocalJson(QUICK_FAVORITES_LS_KEY, items)
}
