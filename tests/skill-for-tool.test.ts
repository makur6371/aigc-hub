import { describe, it, expect } from 'vitest'
import { skillForToolSlug, AGENT_SKILLS } from '@/lib/agent-skills'

describe('skillForToolSlug —— 按工具推断默认技能', () => {
  it('俄区套图工具 → ru-market', () => {
    expect(skillForToolSlug('俄区智能套图-seed206')).toBe('ru-market')
    expect(skillForToolSlug('俄区智能套图-llm01')).toBe('ru-market')
  })

  it('九宫格优先于套图（"电商九宫格模式"两个关键词都有）', () => {
    expect(skillForToolSlug('电商九宫格模式1-q5jcam')).toBe('nine-grid')
    expect(skillForToolSlug('九宫格模式2-amz22h')).toBe('nine-grid')
  })

  it('其他工具按关键词映射', () => {
    expect(skillForToolSlug('模特换背景-1a44qf')).toBe('model-bg')
    expect(skillForToolSlug('电商图替换-seed205')).toBe('ecom-scene')
    expect(skillForToolSlug('商品多图套图-seed203')).toBe('ecom-main')
  })

  it('基础视频工具不套电商展示视频 Skill', () => {
    // 这些是通用视频能力，不是电商场景；套错 Skill 会让 Agent 按卖点分镜去规划风景/人物视频
    expect(skillForToolSlug('基础·图生视频-seed003')).toBeNull()
    expect(skillForToolSlug('基础·文生视频-seed005')).toBeNull()
    expect(skillForToolSlug('基础·首尾帧生视频-seed007')).toBeNull()
    // 真正的电商视频工具才默认带上展示视频 Skill
    expect(skillForToolSlug('电商商品展示视频')).toBe('ecom-showcase-video')
  })

  it('匹配不到 / 空值 → null（不硬塞技能）', () => {
    expect(skillForToolSlug('基础·文生图-seed001')).toBeNull()
    expect(skillForToolSlug('')).toBeNull()
    expect(skillForToolSlug(null)).toBeNull()
    expect(skillForToolSlug(undefined)).toBeNull()
  })

  it('拼多多工具 → pdd-suite', () => {
    expect(skillForToolSlug('拼多多商品图套图-seed001')).toBe('pdd-suite')
  })

  it('返回值必须是真实存在的技能 id（否则前端会选中一个不存在的技能）', () => {
    const slugs = [
      '俄区智能套图-seed206', '九宫格模式2-amz22h', '模特换背景-1a44qf',
      '电商图替换-seed205', '商品多图套图-seed203', '图片放大-seed9', '图生图上传多张-nw0rki',
    ]
    const ids = new Set(AGENT_SKILLS.map((s) => s.id))
    for (const s of slugs) {
      const id = skillForToolSlug(s)
      if (id !== null) expect(ids.has(id), `${s} → ${id} 不存在`).toBe(true)
    }
  })
})
