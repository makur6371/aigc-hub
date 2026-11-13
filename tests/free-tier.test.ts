import { describe, it, expect } from 'vitest'
import { pickFreeTierModels, type ModelTierItem } from '@/lib/free-tier'
import { SECURITY_VERIFY_BONUS_POINTS } from '@/lib/billing/welcome'

// 免费开画板块的数据口径（2026-11-02）
//
// 背景：免费额度制（每用户每日 + 平台总两级）早已上线，但首页/定价页不讲，
// 竞品全把免费档当拉新招牌。板块展示 = 安全验证积分 + 有免费额度的模型清单。
// 这里钉住筛选/映射/排序口径，防止以后接口字段变化把板块悄悄改空或改虚。
describe('pickFreeTierModels', () => {
  const items: ModelTierItem[] = [
    { id: 'v1', name: '视频模型', type: 'VIDEO', typeLabel: '视频生成', dailyUserFreeQuota: 3 },
    { id: 'i1', name: '文生图模型', type: 'IMAGE', typeLabel: '图片生成', dailyUserFreeQuota: 5 },
    { id: 'l1', name: '对话模型', type: 'LLM', typeLabel: '文本对话', dailyUserFreeQuota: 0 },
    { id: 'i2', name: '免费模型', type: 'IMAGE', typeLabel: '图片生成', isFree: true, dailyUserFreeQuota: null },
    { id: 'l2', name: '付费模型', type: 'LLM', typeLabel: '文本对话' },
  ]

  it('只保留有免费额度的模型（含 isFree），0 额度的付费模型不进板块', () => {
    const picked = pickFreeTierModels(items)
    expect(picked.map((m) => m.id)).toEqual(['i2', 'i1', 'v1'])
  })

  it('图片类排最前（对用户最直观），同类别按名称', () => {
    const picked = pickFreeTierModels(items)
    expect(picked[0].id).toBe('i2')
    expect(picked[1].id).toBe('i1')
    expect(picked[2].id).toBe('v1')
  })

  it('typeLabel 缺失时按 type 回退，未知 type 原样展示', () => {
    const picked = pickFreeTierModels([
      { id: 'x1', name: '无标签', type: 'IMAGE', dailyUserFreeQuota: 2 },
      { id: 'x2', name: '新类型', type: 'WHATEVER', dailyUserFreeQuota: 1 },
    ])
    expect(picked[0].typeLabel).toBe('图片生成')
    expect(picked[1].typeLabel).toBe('WHATEVER')
  })

  it('无任何免费模型时返回空数组（板块只展示欢迎积分，不虚标）', () => {
    expect(pickFreeTierModels([{ id: 'a', name: '付费', type: 'IMAGE' }])).toEqual([])
  })
})

describe('安全验证积分单源', () => {
  it('常量为 20（注册不再发放，只在安全验证时一次性发放）', () => {
    expect(SECURITY_VERIFY_BONUS_POINTS).toBe(20)
  })
})
