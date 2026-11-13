import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 问卷奖励防重发：原先只靠 `if (template.rewardGrantedAt) throw` 的**读判**，
// 那是 TOCTOU —— 管理员双击 / 两个管理员同时点，两个请求都能读到 null，
// 各自对全部答题者 adjustPoints 一遍 = 双倍发奖。
// 正解与 invite/settle.ts 一致：updateMany 条件写做原子认领（count===0 即已被别人领走）。
const src = readFileSync(
  resolve(__dirname, '../src/app/api/admin/surveys/[id]/reward/route.ts'),
  'utf8',
)

describe('问卷奖励防重发 —— 必须是原子认领，不能是读判', () => {
  it('用 updateMany + rewardGrantedAt: null 做条件认领', () => {
    expect(src).toMatch(/surveyTemplate\.updateMany\(\{[\s\S]*where:\s*\{\s*id,\s*rewardGrantedAt:\s*null\s*\}/)
  })

  it('认领失败（count===0）直接拒单，不再继续发放', () => {
    expect(src).toMatch(/if\s*\(claimed\.count\s*===\s*0\)/)
    expect(src).toMatch(/claimed\.count\s*===\s*0[\s\S]{0,400}throw new ApiHandlerError/)
  })

  it('认领发生在发放之前（顺序不能反，反了就等于没认领）', () => {
    const claimAt = src.indexOf('surveyTemplate.updateMany')
    const grantAt = src.indexOf('adjustPoints(')
    expect(claimAt).toBeGreaterThan(-1)
    expect(grantAt).toBeGreaterThan(-1)
    expect(claimAt).toBeLessThan(grantAt)
  })

  it('不再在发放后二次 update rewardGrantedAt（重复写会掩盖认领语义）', () => {
    // 原实现：发放完再 surveyTemplate.update({ rewardGrantedAt: new Date() })
    // 现在认领阶段已写入，末尾不应再有这次无条件写
    const afterGrant = src.slice(src.indexOf('adjustPoints('))
    expect(afterGrant).not.toMatch(/surveyTemplate\.update\(\{[\s\S]{0,200}rewardGrantedAt/)
  })
})
