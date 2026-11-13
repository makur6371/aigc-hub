import { describe, it, expect } from 'vitest'
import {
  BASE_TOOL_CATEGORIES,
  ALL_TOOL_CATEGORIES,
  normalizeToolCategory,
  LEGACY_VIDEO_CATEGORIES,
} from '@/lib/constants/categories'

// 视频工具分类合并（2026-10-18 用户决策：「那几个生视频的都归到基础工具的视频生成里」）
//
// 合并前：文生视频 / 图生视频 / 首尾帧生成视频 / 多图参考生成视频 四个近义分类
//   +「动作迁移」错用模型类型名「视频生成」（不在清单 → 被归进垂直领域组）。
// 合并后：统一「视频生成」，且必须落在**基础工具**组里。
describe('视频工具分类归一', () => {
  it('四个历史分类别名都归一到「视频生成」', () => {
    for (const legacy of LEGACY_VIDEO_CATEGORIES) {
      expect(normalizeToolCategory(legacy)).toBe('视频生成')
    }
  })

  it('「视频生成」本身归一后不变（幂等）', () => {
    expect(normalizeToolCategory('视频生成')).toBe('视频生成')
  })

  it('「视频生成」属于基础工具分类（不是垂直领域）', () => {
    // 这条是本次 bug 的核心：不在基础清单里 → ToolStudio 会把它划到「垂直领域」
    expect(BASE_TOOL_CATEGORIES as readonly string[]).toContain('视频生成')
  })

  it('旧的 4 个视频分类不再出现在任何分类清单里（下拉不会重新长回 4 项）', () => {
    const all = ALL_TOOL_CATEGORIES as readonly string[]
    for (const legacy of LEGACY_VIDEO_CATEGORIES) {
      expect(all).not.toContain(legacy)
    }
  })

  it('非视频分类不受影响', () => {
    expect(normalizeToolCategory('电商商拍')).toBe('电商商拍')
    expect(normalizeToolCategory('文生图')).toBe('文生图')
    expect(normalizeToolCategory('AI 漫剧')).toBe('AI 漫剧')
  })

  it('空值与未分类：归一后仍为空，交由调用方落「其他」', () => {
    expect(normalizeToolCategory(null)).toBe('')
    expect(normalizeToolCategory('')).toBe('')
    expect(normalizeToolCategory(undefined)).toBe('')
  })

  it('基础工具分类里视频只占一格（原来占四格）', () => {
    // 只看「视频」类；`图生图` 是图片类工具，本来就该留在基础分类里，不受影响
    const videoCats = (BASE_TOOL_CATEGORIES as readonly string[]).filter((c) => c.includes('视频'))
    expect(videoCats).toEqual(['视频生成'])
  })
})
