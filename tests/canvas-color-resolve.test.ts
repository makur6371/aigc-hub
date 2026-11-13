import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveCssColor, __clearResolveCache, FALLBACK_COLOR } from '@/lib/css-color'

/**
 * 缩略图节点颜色 —— 回归防护（第 3 条）。
 *
 * 根因：categoryColors 的值是 CSS 变量（'var(--accent)'），
 * 而 SVG 的 fill **属性不解析 CSS 变量**（不像 style/className 走 CSS 引擎），
 * 于是缩略图里所有节点都变成 fallback 灰，与画布主区域（用 style 上色）对不上。
 *
 * 这里直接测试**实现本体**（不是复制一份到测试里）。
 */

const store: Record<string, string> = { '--accent': '#7d50e0', '--warning-deep': '#d48806' }

beforeEach(() => {
  __clearResolveCache()
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (n: string) => store[n] ?? '',
  }))
})

describe('resolveCssColor —— SVG fill 不认 CSS 变量', () => {
  it('var(--accent) 解析为真实色值（不是原样丢给 SVG）', () => {
    expect(resolveCssColor('var(--accent)')).toBe('#7d50e0')
    expect(resolveCssColor('var(--warning-deep)')).toBe('#d48806')
  })

  it('具体颜色原样返回（不多此一举）', () => {
    expect(resolveCssColor('#ff0000')).toBe('#ff0000')
    expect(resolveCssColor('rgb(1,2,3)')).toBe('rgb(1,2,3)')
  })

  it('空值 / 未定义变量 → 兜底灰，绝不返回空串（空 fill 会渲染成黑或透明）', () => {
    expect(resolveCssColor('')).toBe(FALLBACK_COLOR)
    expect(resolveCssColor(null)).toBe(FALLBACK_COLOR)
    expect(resolveCssColor('var(--not-defined)')).toBe(FALLBACK_COLOR)
    for (const v of ['', null, 'var(--x)', 'var(--accent)']) {
      expect(resolveCssColor(v).length).toBeGreaterThan(0)
    }
  })

  it('返回值必须是 SVG 能吃的字面色值（不含 var(）', () => {
    for (const v of ['var(--accent)', 'var(--warning-deep)', '#fff']) {
      expect(resolveCssColor(v)).not.toContain('var(')
    }
  })

  it('无 document（SSR 阶段）不崩，给兜底色', () => {
    vi.stubGlobal('getComputedStyle', undefined)
    expect(resolveCssColor('var(--accent)')).toBe(FALLBACK_COLOR)
  })

  it('带缓存：同一变量第二次不再读 getComputedStyle', () => {
    const spy = vi.fn(() => ({ getPropertyValue: (n: string) => store[n] ?? '' }))
    vi.stubGlobal('getComputedStyle', spy)
    resolveCssColor('var(--accent)')
    resolveCssColor('var(--accent)')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
