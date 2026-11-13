import { describe, it, expect } from 'vitest'
import { localDayKey, isTodayKey } from '@/lib/day-key'
import { teamDayKey } from '@/lib/billing/team'

// 业务「日」只有一个来源。这类 bug 的形态是「同一个概念被实现多次」：
//   - 免费额度 localDayKey / 团队额度 teamDayKey / 测试里的 toISOString().slice(0,10)
// 三者一旦有一处改用 UTC（或有人手写），就会出现
// 「扣费侧已归零、展示侧还显示昨天用量」的分叉。
// 这里把「唯一来源 + 跨天判定」钉死，防止再次各写一份。

describe('业务日唯一来源', () => {
  it('两端点是同一个函数（teamDayKey 只是薄封装）', () => {
    const d = new Date(2026, 6, 6, 23, 30)
    expect(teamDayKey(d)).toBe(localDayKey(d))
  })

  it('本地日不去 UTC 取整：本地 0 点后即算新的一天', () => {
    // 2026-07-06 00:30 本地时间。toISOString() 在东八区会落到 07-05（UTC），
    // 这正是本文件历史上「早间必失败」的根因 —— 分桶必须按本地日。
    const d = new Date(2026, 6, 6, 0, 30, 0)
    expect(localDayKey(d)).toBe('2026-07-06')
  })

  it('补零', () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(localDayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('isTodayKey —— 跨天归零判定', () => {
  it('昨天的键不是今天（真值判断会把昨天当今天，这正是修掉的 bug）', () => {
    expect(isTodayKey('2000-01-01')).toBe(false)
    expect(isTodayKey(null)).toBe(false)
    expect(isTodayKey(undefined)).toBe(false)
    expect(isTodayKey('')).toBe(false)
  })

  it('今天的键是今天', () => {
    expect(isTodayKey(localDayKey())).toBe(true)
  })
})
