import { describe, it, expect } from 'vitest'
import { getTeamLimitState, teamDayKey, effectiveTeamLimits } from '@/lib/billing/team'

// 成员级额度必须「积分与豆对称」。
//
// 真实缺口（本轮修的）：豆额度原写死读团队默认值 —— 只有积分能按成员单独设。
// 而豆比积分贵得多（视频专用，单条可达 300 豆），恰恰最需要按人管控。
// 这类「一边有一边没」的不对称是最容易再次发生的形态，用测试锁死三级回落。

const base = {
  id: 'm', teamDailyLimit: null as number | null, teamDailyBeans: null as number | null,
  teamSpentDay: null as string | null, teamSpentPoints: 0, teamSpentBeans: 0,
}
const TEAM = { defaultDailyLimit: 500, defaultDailyBeans: 200 }
// 必须用 teamDayKey()：它是业务本地日（生产 TZ=Asia/Shanghai）。
// toISOString().slice(0,10) 是 UTC，北京 00:00-08:00 会差一天 → 本文件曾因此在早间必失败。
const TODAY = teamDayKey()

describe('成员额度三级回落（积分与豆对称）', () => {
  it('都没单独设 → 用团队默认', async () => {
    const st = await getTeamLimitState({ ...base }, TEAM)
    expect(st.limitPoints).toBe(500)
    expect(st.limitBeans).toBe(200)
  })

  it('积分单独设 → 只覆盖积分，豆仍用团队默认', async () => {
    const st = await getTeamLimitState({ ...base, teamDailyLimit: 20 }, TEAM)
    expect(st.limitPoints).toBe(20)
    expect(st.limitBeans).toBe(200)
  })

  it('豆单独设 → 只覆盖豆（本轮修的能力）', async () => {
    const st = await getTeamLimitState({ ...base, teamDailyBeans: 5 }, TEAM)
    expect(st.limitPoints).toBe(500)
    expect(st.limitBeans).toBe(5)
  })

  it('两者都单独设 → 各自生效', async () => {
    const st = await getTeamLimitState({ ...base, teamDailyLimit: 20, teamDailyBeans: 5 }, TEAM)
    expect(st.limitPoints).toBe(20)
    expect(st.limitBeans).toBe(5)
  })

  it('团队默认都没设 → 不限（null，不是 0=不能用）', async () => {
    const st = await getTeamLimitState({ ...base }, { defaultDailyLimit: 0, defaultDailyBeans: 0 })
    expect(st.limitPoints).toBeNull()
    expect(st.limitBeans).toBeNull()
  })

  it('无团队（自付）→ 不限', async () => {
    const st = await getTeamLimitState({ ...base }, null)
    expect(st.limitPoints).toBeNull()
    expect(st.limitBeans).toBeNull()
  })

  it('跨天 → 当日用量归零（额度每天重置）', async () => {
    const st = await getTeamLimitState(
      { ...base, teamSpentDay: '2000-01-01', teamSpentPoints: 999, teamSpentBeans: 999 }, TEAM,
    )
    expect(st.spentPoints).toBe(0)
    expect(st.spentBeans).toBe(0)
  })

  it('同日 → 读回当日用量', async () => {
    const st = await getTeamLimitState(
      { ...base, teamSpentDay: TODAY, teamSpentPoints: 30, teamSpentBeans: 7 }, TEAM,
    )
    expect(st.spentPoints).toBe(30)
    expect(st.spentBeans).toBe(7)
  })
})

// 读接口与扣费侧必须同口径：成员没单独设时要回落到团队默认值。
// 曾经 /api/user/team 直接回 teamDailyLimit(null) → 成员看到「不限」，
// 实际却被团队默认额度拦下（显示与执行分叉）。
describe('effectiveTeamLimits —— 读接口与扣费侧同口径', () => {
  it('成员未单独设 → 回落到团队默认，而不是 null（不限）', () => {
    expect(effectiveTeamLimits({}, TEAM)).toEqual({ limitPoints: 500, limitBeans: 200 })
  })

  it('成员单独设 → 覆盖团队默认', () => {
    expect(effectiveTeamLimits({ teamDailyLimit: 20, teamDailyBeans: 5 }, TEAM))
      .toEqual({ limitPoints: 20, limitBeans: 5 })
  })

  it('团队默认为 0 → 不限（null，不是上限 0）', () => {
    expect(effectiveTeamLimits({}, { defaultDailyLimit: 0, defaultDailyBeans: 0 }))
      .toEqual({ limitPoints: null, limitBeans: null })
  })

  it('无团队 → 不限', () => {
    expect(effectiveTeamLimits({}, null)).toEqual({ limitPoints: null, limitBeans: null })
  })
})
