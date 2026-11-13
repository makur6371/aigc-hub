import { describe, it, expect } from 'vitest'
import { ownerIdFrom, teamDayKey, getTeamLimitState, ledgerPayer } from '@/lib/billing/team'

// 企业团队共享池 = 直接动钱的改动。这里锁住「默认自付」这条底线：
// 存量 34 个用户没加入任何团队，billingOwnerId 全为 null，
// 任何一处把 null 判成「要用团队池」都会让所有人的扣费走错账号。

describe('ownerIdFrom —— 计费归属默认自付', () => {
  it('billingOwnerId 为 null/undefined → 扣自己（存量用户行为不变）', () => {
    expect(ownerIdFrom(null, 'me')).toBe('me')
    expect(ownerIdFrom(undefined, 'me')).toBe('me')
    expect(ownerIdFrom('', 'me')).toBe('me')
  })

  it('有归属 → 扣出资人（团队池）', () => {
    expect(ownerIdFrom('boss', 'me')).toBe('boss')
  })
})

describe('teamDayKey —— 每日额度分桶（跨天自动归零）', () => {
  it('本地日 YYYY-MM-DD，补零', () => {
    expect(teamDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(teamDayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('getTeamLimitState —— 成员额度与今日已用', () => {
  const memberBase = { id: 'm', teamDailyLimit: null, teamSpentDay: null, teamSpentPoints: 0, teamSpentBeans: 0 }

  it('成员没单独设限额 → 用团队默认', async () => {
    const st = await getTeamLimitState(
      { ...memberBase, teamDailyLimit: null },
      { defaultDailyLimit: 100, defaultDailyBeans: 50 },
    )
    expect(st.limitPoints).toBe(100)
    expect(st.limitBeans).toBe(50)
  })

  it('成员单独设了限额 → 覆盖团队默认（可单独放宽或收紧）', async () => {
    const st = await getTeamLimitState(
      { ...memberBase, teamDailyLimit: 20 },
      { defaultDailyLimit: 100, defaultDailyBeans: 50 },
    )
    expect(st.limitPoints).toBe(20)
  })

  it('限额为 0/未设 → null 表示不限（不是「不能用」）', async () => {
    const st = await getTeamLimitState({ ...memberBase }, { defaultDailyLimit: 0, defaultDailyBeans: 0 })
    expect(st.limitPoints).toBeNull()
    expect(st.limitBeans).toBeNull()
    const st2 = await getTeamLimitState({ ...memberBase }, null)
    expect(st2.limitPoints).toBeNull()
  })

  it('同日 → 已用量取自存的值', async () => {
    const st = await getTeamLimitState(
      { ...memberBase, teamSpentDay: teamDayKey(), teamSpentPoints: 30, teamSpentBeans: 5 },
      { defaultDailyLimit: 100, defaultDailyBeans: 0 },
    )
    expect(st.spentPoints).toBe(30)
    expect(st.spentBeans).toBe(5)
  })

  it('跨天 → 已用量归零（额度每天重置）', async () => {
    const st = await getTeamLimitState(
      { ...memberBase, teamSpentDay: '2000-01-01', teamSpentPoints: 999, teamSpentBeans: 999 },
      { defaultDailyLimit: 100, defaultDailyBeans: 0 },
    )
    expect(st.spentPoints).toBe(0)
    expect(st.spentBeans).toBe(0)
  })
})


// 账本视角注解：同一条流水在「老板账本」和「成员账本」里语义不同。
// 老板账本要能对平钱包净变动 → 必须有「团队消费（谁花的）」这一类行；
// 成员账本要能分辨「不是我的钱」。这里锁住判定口径，避免前端各自推导出不同结果。
describe('ledgerPayer —— 账本支付方视角', () => {
  it('billingOwnerId 为 null/自己 → 自付', () => {
    expect(ledgerPayer(null, 'me')).toEqual({ paidBy: 'self', payerName: null })
    expect(ledgerPayer(undefined, 'me')).toEqual({ paidBy: 'self', payerName: null })
    expect(ledgerPayer('me', 'me')).toEqual({ paidBy: 'self', payerName: null })
  })

  it('指向他人 → 团队（带出钱人名字）', () => {
    expect(ledgerPayer('boss', 'me', '张三')).toEqual({ paidBy: 'team', payerName: '张三' })
  })

  it('出钱人名字缺失 → 回落「企业账号」，不能显示空白', () => {
    expect(ledgerPayer('boss', 'me')).toEqual({ paidBy: 'team', payerName: '企业账号' })
    expect(ledgerPayer('boss', 'me', '   ')).toEqual({ paidBy: 'team', payerName: '企业账号' })
  })
})
