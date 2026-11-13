import { describe, it, expect } from 'vitest'
import { composeAnswerMessage } from '@/lib/agent-message'

/**
 * 多问题选项卡：用户一次只答一题时，不能把整轮提前发出去。
 *
 * 前端策略是「先收集、全部选完再一起发」，据此把「多题合并」收敛到
 * composeAnswerMessage 这个纯函数里；这里锁住它的行为。
 */
describe('composeAnswerMessage', () => {
  const qs = [
    { question: '要几张？', options: ['1 张', '4 张'] },
    { question: '用哪个模型？', options: ['图像模型 A', '图像模型 B'] },
  ]

  it('多题合并：按题拼接，一行一题', () => {
    const text = composeAnswerMessage(qs, { 0: '4 张', 1: '图像模型 B' })
    expect(text).toBe('关于「要几张？」，我选：4 张\n关于「用哪个模型？」，我选：图像模型 B')
  })

  it('只答一题：只输出该题一行，不会替用户瞎答其他题', () => {
    const text = composeAnswerMessage(qs, { 0: '4 张' })
    expect(text).toBe('关于「要几张？」，我选：4 张')
    expect(text).not.toContain('模型')
  })

  it('一题未答：返回空串（调用方据此不发请求）', () => {
    expect(composeAnswerMessage(qs, {})).toBe('')
  })

  it('单题是退化情形', () => {
    expect(composeAnswerMessage([qs[0]], { 0: '1 张' }))
      .toBe('关于「要几张？」，我选：1 张')
  })
})
