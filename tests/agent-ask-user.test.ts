import { describe, it, expect } from 'vitest'
import { executeAction } from '@/lib/agent-tool-loop'
import { TOOL } from '@/lib/agent-tools'

/**
 * ask_user 参数名容错 —— 实测模型不按 schema 来，只认 questions 会让用户什么也看不到。
 *
 * 注：题干/选项现在走 `askQuestions`（前端渲染可点卡片），`reply` 只留引导语，
 * 因此这里断言 askQuestions 而非 reply —— 否则同一份问题会被渲染两遍。
 */
const ctx = () => ({ emit: () => {} }) as never
const noRun = async () => { throw new Error('不应被调用') }

describe('ask_user 参数名容错', () => {
  it('标准 questions 数组', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { questions: [{ question: '要几张？', options: ['1 张', '4 张'] }] },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    // 结构化选项走 askQuestions（前端渲染卡片），reply 只留引导语 —— 避免渲染两遍
    expect(out.askQuestions![0].question).toBe('要几张？')
    expect(out.askQuestions![0].options).toContain('4 张')
    expect(out.reply).not.toContain('请补充一下具体需求')
  })

  it('questions 是字符串 → 当成一个问题', async () => {
    const out = await executeAction({
      name: TOOL.askUser, args: { questions: '你想画什么？' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions![0].question).toBe('你想画什么？')
  })

  it('写成 question 数组（单数）/ 对象用 text 作题干 / 用 choices 作选项', async () => {
    const a = await executeAction({
      name: TOOL.askUser, args: { question: [{ text: '风格？', choices: ['写实', '插画'] }] },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(a.askQuestions![0].question).toBe('风格？')
    expect(a.askQuestions![0].options).toContain('插画')
  })

  it('完全解析不出问题 → 用 reason 兜底，不给空话', async () => {
    const out = await executeAction({
      name: TOOL.askUser, args: { reason: '需要知道目标平台才能继续' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.reply).toContain('需要知道目标平台才能继续')
  })

  it('什么都没有 → 仍是可读的兜底文案', async () => {
    const out = await executeAction({
      name: TOOL.askUser, args: {},
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.reply).toBe('请补充一下具体需求，我好继续。')
    expect(out.done).toBe(true)
  })
})
