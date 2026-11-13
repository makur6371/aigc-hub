import { describe, it, expect } from 'vitest'
import { callFormFromModelType } from '@/lib/media-kinds'

// 后台「调用记录」拆成 任务型 / 会话型 两张表，分类依据必须是**唯一且稳定**的。
// 为什么不用 outputKind：历史数据里它可能为空（早期没写这一列），会漏行、判错。
// 这里把判定钉住，防止后人改成按 outputKind 猜而静默错分。

describe('callFormFromModelType —— 任务型 vs 会话型', () => {
  it('大语言模型（TEXT / VISION）→ 会话型', () => {
    expect(callFormFromModelType('TEXT')).toBe('llm')
    expect(callFormFromModelType('VISION')).toBe('llm')
    // 大小写不敏感（DB 里存大写，但别依赖调用方）
    expect(callFormFromModelType('text')).toBe('llm')
    expect(callFormFromModelType('vision')).toBe('llm')
  })

  it('生成类（IMAGE / VIDEO / AUDIO）→ 任务型', () => {
    expect(callFormFromModelType('IMAGE')).toBe('task')
    expect(callFormFromModelType('VIDEO')).toBe('task')
    expect(callFormFromModelType('AUDIO')).toBe('task')
    expect(callFormFromModelType('image')).toBe('task')
  })

  it('空值不抛错，按任务型兜底（非文本即生成）', () => {
    expect(callFormFromModelType(null)).toBe('task')
    expect(callFormFromModelType(undefined)).toBe('task')
    expect(callFormFromModelType('')).toBe('task')
  })

  it('未知类型归任务型（宁可让它进带产物的表，也别混进 LLM 表）', () => {
    expect(callFormFromModelType('SOMETHING_NEW')).toBe('task')
  })
})
