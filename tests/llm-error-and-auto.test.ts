import { describe, expect, it } from 'vitest'
import { friendlyLlmError } from '@/lib/friendly-llm-error'
import { AUTO_LLM_MODEL_ID, isAutoLlm } from '@/lib/auto-llm'

describe('LLM 失败提示', () => {
  it('图片过大或张数过多时提示压缩/减少张数/切换模型', () => {
    expect(friendlyLlmError('413 Payload Too Large')).toContain('压缩图片')
    expect(friendlyLlmError('too many images in request')).toContain('减少张数')
  })

  it('上游不可用时提示稍后重试或切换模型', () => {
    expect(friendlyLlmError('503 Service Unavailable')).toContain('上游模型暂时不可用')
    expect(friendlyLlmError('upstream timeout')).toContain('上游模型暂时不可用')
  })

  it('认不出的错误保留原文', () => {
    expect(friendlyLlmError('模型参数错误')).toBe('模型参数错误')
  })
})

describe('Auto-LLM 哨兵', () => {
  it('只识别固定哨兵值', () => {
    expect(isAutoLlm(AUTO_LLM_MODEL_ID)).toBe(true)
    expect(isAutoLlm('some-model')).toBe(false)
    expect(isAutoLlm(null)).toBe(false)
  })
})
