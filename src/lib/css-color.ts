/**
 * CSS 变量 → SVG 可用的字面色值。
 *
 * 为什么独立成模块：canvas-widgets 的缩略图用 SVG 的 fill 上色，
 * 而 **fill 属性不解析 CSS 变量**（不像 style/className 走 CSS 引擎），
 * 于是所有节点都会 fallback 成灰 —— 与画布主区域颜色对不上（第 3 条）。
 * 抽出来是为了能被单测直接 import 真身，避免"测试里复制一份实现"那种假测试。
 */

const cache = new Map<string, string>()

/** 解析不出时统一兜底色（与调用方原来的 fallback 一致） */
export const FALLBACK_COLOR = '#8C8C8C'

export function resolveCssColor(value: string | undefined | null): string {
  if (!value) return FALLBACK_COLOR
  if (!value.startsWith('var(')) return value
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK_COLOR
  const cached = cache.get(value)
  if (cached) return cached
  const name = value.slice(4, -1).trim()   // 'var(--accent)' → '--accent'
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const out = resolved || FALLBACK_COLOR
  cache.set(value, out)
  return out
}

/** 测试用：清缓存（生产不需要） */
export function __clearResolveCache() { cache.clear() }
