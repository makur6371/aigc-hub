import { describe, it, expect } from 'vitest'
import { AGENT_SKILLS } from '@/lib/agent-skills'

/**
 * 俄区套图 skill 的「俄语文案」硬性约束（防回归）
 *
 * 用户明确要求：俄区套图产出的每张图都要有俄语文案。
 * 背景：俄区买家几乎完全靠图上的俄语卖点决定是否点击，
 * 不带文案的图在 Ozon / WB 上转化极差。
 *
 * 这条约束以前只写了笼统的「画面带俄语卖点文案」，
 * 模型经常理解成「有的图带就行」，所以改成显式硬要求。
 */
describe('ru-market skill：俄语文案硬约束', () => {
  const ru = AGENT_SKILLS.find((s) => s.id === 'ru-market')!

  it('技能存在且归属电商套图', () => {
    expect(ru).toBeTruthy()
    expect(ru.group).toBe('电商套图')
  })

  it('声明「每一张图都必须带俄语文案」，且无例外方向', () => {
    expect(ru.promptFragment).toContain('每一张图都必须带俄语文案')
    expect(ru.promptFragment).toContain('没有例外方向')
  })

  it('明确要求用西里尔字母的真实俄语，不许用英语冒充', () => {
    expect(ru.promptFragment).toContain('西里尔字母')
    expect(ru.promptFragment).toMatch(/不要用英语单词冒充俄语/)
  })

  it('要求文案对应该方向（不许所有图堆同一句）', () => {
    expect(ru.promptFragment).toContain('不许所有图堆同一句')
  })

  it('禁止「加一段俄语文案」这类无内容占位描述', () => {
    expect(ru.promptFragment).toContain('不给内容的占位描述')
  })

  it('用户本轮显式选择的语言优先于本技能默认（不越权）', () => {
    expect(ru.promptFragment).toContain('用户本轮选择为准')
  })

  it('文案不得遮挡产品主体与 logo', () => {
    expect(ru.promptFragment).toContain('不能遮挡产品主体')
    expect(ru.promptFragment).toContain('logo')
  })

  it('旧的笼统表述已删除（避免与新约束重复且更弱）', () => {
    expect(ru.promptFragment).not.toContain('说明：画面带俄语卖点文案')
  })

  it('不再宣称「白底主图」（俄区不用白底纯色背景）', () => {
    // skill 的预设方向里不该出现白底
    expect(ru.promptFragment).not.toContain('白底')
  })
})

/**
 * 方向表：main 必出 + 10 个副图方向 + 副图互不相同。
 *
 * 用户给的结构（参考实现）：第 1 张必须是 main，其余从 10 个副图方向里选，
 * 且副图方向必须彼此不同（相似角度如 detail_closeup / material_quality 不能同选）。
 * 加测试的原因：以前技能只写「预设方向：生活场景主图、卖点信息图…」几个自由词组，
 * 模型没有可对齐的 ID，选出来每次都不同，也没保证第一张是主图。
 */
describe('ru-market skill：出图方向表', () => {
  const ru = AGENT_SKILLS.find((s) => s.id === 'ru-market')!

  it('第 1 张必须是 main', () => {
    expect(ru.promptFragment).toContain('第 1 张必须是 main')
    expect(ru.promptFragment).toContain('第 1 张（index 0）')
  })

  it('10 个副图方向的 ID 全部登记（模型要有稳定 ID 可对齐）', () => {
    for (const id of [
      'detail_closeup', 'feature_demo', 'size_comparison', 'multi_angle', 'material_quality',
      'scene_placement', 'maintenance', 'comparison', 'color_variants', 'selling_points',
    ]) {
      expect(ru.promptFragment, `缺方向 ${id}`).toContain(id)
    }
  })

  it('要求副图方向各不相同（避免相似角度）', () => {
    expect(ru.promptFragment).toContain('必须各不相同')
    // 明确点出易重复的组合，否则模型分不清"相似"的边界
    expect(ru.promptFragment).toContain('detail_closeup 与 material_quality')
  })

  it('main 要求干净背景但保留实拍感（不回退成纯色底板）', () => {
    expect(ru.promptFragment).toContain('背景干净简洁')
    expect(ru.promptFragment).toContain('纯色底板')
  })

  it('旧的自由词组方向已删除（避免与新表重复且更模糊）', () => {
    expect(ru.promptFragment).not.toContain('预设方向：生活场景主图')
  })
})
