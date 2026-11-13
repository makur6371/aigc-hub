import { describe, it, expect } from 'vitest'
import { parsePagination, toPositiveInt } from '@/lib/api-handler'

// 分页参数直接来自 URL，`?page=abc` / `?pageSize=` / 负数是常态输入。
// 旧实现 Math.max(1, parseInt(x)) 在 parseInt 返回 NaN 时仍是 NaN，
// 会把 skip/take=NaN 传给 Prisma → 查询报错（约 24 个列表接口共用此函数）。
// 这里锁死「任何输入都返回合法正整数」。

const u = (qs: string) => new URL(`https://x.test/api?${qs}`)

describe('parsePagination —— 非法输入必须回落默认值', () => {
  it('非数字 page/pageSize → 默认值（不是 NaN）', () => {
    for (const qs of ['page=abc', 'page=', 'pageSize=abc', 'pageSize=', 'page=abc&pageSize=xyz']) {
      const { page, pageSize } = parsePagination(u(qs), { page: 1, pageSize: 12 })
      expect(Number.isInteger(page), `page for ${qs}`).toBe(true)
      expect(Number.isInteger(pageSize), `pageSize for ${qs}`).toBe(true)
      expect(page).toBe(1)
      expect(pageSize).toBe(12)
    }
  })

  it('缺省 → 默认值', () => {
    expect(parsePagination(u(''), { page: 2, pageSize: 30 })).toEqual({ page: 2, pageSize: 30 })
  })

  it('合法值照常生效', () => {
    expect(parsePagination(u('page=3&pageSize=25'), {})).toEqual({ page: 3, pageSize: 25 })
  })

  it('0 / 负数 / 小数 → 收敛到合法范围', () => {
    expect(parsePagination(u('page=0&pageSize=0'), {}).page).toBe(1)
    expect(parsePagination(u('page=-5&pageSize=-3'), {}).page).toBe(1)
    expect(parsePagination(u('page=2.9&pageSize=7.5'), {})).toEqual({ page: 2, pageSize: 7 })
  })

  it('pageSize 超过 maxPageSize → 截断', () => {
    expect(parsePagination(u('pageSize=9999'), { maxPageSize: 50 }).pageSize).toBe(50)
  })

  it('极大数值不产生 Infinity，pageSize 截断', () => {
    // 超长数字串：parseInt 会得到 1e30 这类大数，Math.min 截断后仍须是有限整数
    const big = '9'.repeat(30)
    const { page, pageSize } = parsePagination(u(`page=${big}&pageSize=${big}`), { maxPageSize: 100 })
    expect(Number.isFinite(page)).toBe(true)
    expect(Number.isFinite(pageSize)).toBe(true)
    expect(pageSize).toBe(100)
  })
})

describe('toPositiveInt —— limit 类参数同一套保护', () => {
  it('非数字 → 默认值（不是 NaN）', () => {
    expect(toPositiveInt('abc', 20, 50)).toBe(20)
    expect(toPositiveInt('', 20, 50)).toBe(20)
    expect(toPositiveInt(null, 20, 50)).toBe(20)
  })
  it('超出上限 → 截断；0/负 → 1', () => {
    expect(toPositiveInt('999', 20, 50)).toBe(50)
    expect(toPositiveInt('0', 20, 50)).toBe(1)
    expect(toPositiveInt('-5', 20, 50)).toBe(1)
  })
  it('合法值原样返回', () => {
    expect(toPositiveInt('30', 20, 50)).toBe(30)
  })
})
