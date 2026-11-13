import { describe, expect, it } from 'vitest'
import {
  QUICK_FAVORITE_PAGES,
  mergeQuickFavorite,
  parseQuickFavorites,
} from '@/lib/quick-favorites'

describe('quick favorites storage', () => {
  it('parses valid site-relative favorites and removes duplicates', () => {
    const items = parseQuickFavorites(JSON.stringify([
      { label: '首页', href: '/', addedAt: 1 },
      { label: '重复首页', href: '/', addedAt: 2 },
      { label: 'Agent', href: '/agent', addedAt: 3 },
      { label: '外部链接', href: 'https://example.com', addedAt: 4 },
      { label: '', href: '/canvas', addedAt: 5 },
    ]))
    expect(items.map((item) => item.href)).toEqual(['/', '/agent'])
  })

  it('does not throw on malformed local data', () => {
    expect(parseQuickFavorites('{bad json')).toEqual([])
    expect(parseQuickFavorites(JSON.stringify({ href: '/' }))).toEqual([])
  })

  it('adds a favorite once and keeps the newest item first', () => {
    const first = mergeQuickFavorite([], { label: '首页', href: '/' })
    expect(first.added).toBe(true)
    const second = mergeQuickFavorite(first.items, { label: '画布', href: '/canvas' })
    expect(second.items.map((item) => item.href)).toEqual(['/canvas', '/'])
    expect(mergeQuickFavorite(second.items, { label: '首页副本', href: '/' }).added).toBe(false)
  })

  it('offers the requested built-in pages', () => {
    expect(QUICK_FAVORITE_PAGES.map((item) => item.href)).toEqual(
      expect.arrayContaining(['/', '/agent', '/canvas', '/tools']),
    )
  })
})
