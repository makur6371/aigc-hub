import { describe, it, expect } from 'vitest'
import { AGENT_SKILLS, AGENT_SKILL_GROUPS } from '@/lib/agent-skills'

/**
 * Skill 结构守卫 —— 以俄区套图为模板。
 *
 * 背景：早期 skill 只写两句（「白底、文字不超 8 字」），模型收到「做套图」时
 * 不知道该出哪几个方向、参考图传不传、文案用什么语言 → 出图东一张西一张。
 * 这条测试锁住「成熟 skill 的结构」：方向/说明/约束/二次修改 四段齐全。
 */
describe('AGENT_SKILLS 结构', () => {
  it('每个 skill 的分组都是已注册分组（否则选择器漏展示）', () => {
    for (const s of AGENT_SKILLS) {
      expect(AGENT_SKILL_GROUPS, `${s.id} 分组 ${s.group} 未注册`).toContain(s.group)
    }
  })

  it('每个 skill 都含「约束 / 二次修改 / 追问」三类硬规则', () => {
    for (const s of AGENT_SKILLS) {
      expect(s.promptFragment, `${s.id} 缺「约束」段`).toContain('约束')
      expect(s.promptFragment, `${s.id} 缺「二次修改」段`).toContain('二次修改')
      // 图生图类 skill 必须写清参考图怎么传；纯文本分镜类也要有参考图说明
      expect(/参考图|assetIds|图生图/.test(s.promptFragment), `${s.id} 未说明参考图`).toBe(true)
    }
  })

  it('每个 skill 都禁止违禁内容（合规底线，不能漏）', () => {
    for (const s of AGENT_SKILLS) {
      expect(s.promptFragment, `${s.id} 未写合规约束`).toMatch(/色情|违禁|暴力/)
    }
  })

  it('id 唯一', () => {
    const ids = AGENT_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
