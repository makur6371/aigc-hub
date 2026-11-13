import { describe, it, expect } from 'vitest'
import { AGENT_SKILLS } from '@/lib/agent-skills'

/**
 * 拼多多套图 Skill —— 平台适配守卫。
 *
 * 调研结论（2026-10-29）：PDD 与淘宝心智相反——首图少字抓点击，
 * 中文大字卖点放轮播后位与详情长图；白底包是活动合规图零文字。
 * 该测试钉住这些「与通用电商主图不同」的决策，防止被通用化稀释。
 */
describe('拼多多套图 Skill', () => {
  const skill = AGENT_SKILLS.find((s) => s.id === 'pdd-suite')

  it('已注册且在电商套图分组', () => {
    expect(skill, 'pdd-suite 未注册').toBeTruthy()
    expect(skill!.group).toBe('电商套图')
    expect(skill!.description.length).toBeGreaterThan(8)
  })

  it('包含五类产出方向（首图/卖点轮播/详情长图/白底包/SKU）', () => {
    const p = skill!.promptFragment
    expect(p).toContain('main_search')
    expect(p).toContain('carousel_sell')
    expect(p).toContain('detail_long')
    expect(p).toContain('white_pack')
    expect(p).toContain('sku_variant')
  })

  it('首图与白底包禁字、轮播与详情允许中文大字（PDD 分层文字策略）', () => {
    const p = skill!.promptFragment
    expect(p).toContain('main_search 与 white_pack **禁止任何文字**')
    expect(p).toContain('carousel_sell 与 detail_long 允许中文文案')
  })

  it('有 PDD 特有的合规红线（站外导流 / 极限词 / 功效承诺）', () => {
    const p = skill!.promptFragment
    expect(p).toContain('站外导流')
    expect(p).toContain('极限词')
    expect(p).toContain('功效承诺')
  })

  it('遵守平台四段式结构：用法 / 说明 / 约束 / 二次修改', () => {
    const p = skill!.promptFragment
    expect(p).toContain('用法：')
    expect(p).toContain('说明：')
    expect(p).toContain('约束：')
    expect(p).toContain('二次修改')
  })

  it('参考图纪律与全平台一致（assetIds 图生图 + 禁复述外观）', () => {
    const p = skill!.promptFragment
    expect(p).toContain('assetIds')
    expect(p).toContain('不要在提示词里复述产品颜色/材质')
  })
})
