import { describe, it, expect } from 'vitest'
import { formatUserMemoryText, formatUserPreferencesText } from '@/lib/agent-plan'

/**
 * 用户记忆（自述）注入 —— 回归防护。
 *
 * 背景：Agent 上下文里的「用户偏好」原本只有技术参数（模型/比例/档位），
 * 没有一处是「用户是谁」。用户每次都要重新交代自己是做什么的。
 * 这次加了手填的长期记忆，与偏好**分两段**注入。
 *
 * 为什么分两段而不是拼成一句：偏好缺失可由代码兜底（默认模型/默认比例），
 * 记忆无法推断。混在一起模型会把两者当成同一类事实，也不好单独调试。
 */
describe('formatUserMemoryText', () => {
  it('有内容时包一句引导语（让模型知道这是长期事实）', () => {
    const out = formatUserMemoryText('我是做俄罗斯电商的')
    expect(out).toContain('用户自述')
    expect(out).toContain('我是做俄罗斯电商的')
  })

  it('声明「本轮要求优先」，避免旧记忆压过用户当前意图', () => {
    expect(formatUserMemoryText('x')).toContain('与本轮要求冲突时以本轮为准')
  })

  it('空/空白/null 都返回空串（调用方据此跳过注入，不塞空字段）', () => {
    expect(formatUserMemoryText('')).toBe('')
    expect(formatUserMemoryText('   ')).toBe('')
    expect(formatUserMemoryText(null)).toBe('')
    expect(formatUserMemoryText(undefined)).toBe('')
  })

  it('与偏好文本是两个独立函数（不共用一段引导语）', () => {
    const mem = formatUserMemoryText('m')
    const pref = formatUserPreferencesText({ imageRatio: '1:1' }, () => 'X')
    expect(mem).not.toBe(pref)
    expect(pref).toContain('用户全局偏好')
    expect(mem).not.toContain('用户全局偏好')
  })
})
