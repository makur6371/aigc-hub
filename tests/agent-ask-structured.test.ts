import { describe, it, expect } from 'vitest'
import { executeAction } from '@/lib/agent-tool-loop'
import { TOOL } from '@/lib/agent-tools'

/**
 * ask_user 结构化选项 —— 前端据此渲染可点按钮。
 *
 * 为什么要结构化：只给文字的话，用户得照着屏幕手打「A」或复述整句，
 * 多题时更是要自己对齐"第几个问题答的是哪个"。把 questions/options 原样上抛，
 * 前端就能渲染成一组可点按钮，点一下即作答。
 */
const ctx = () => ({ emit: () => {} }) as never
const noRun = async () => { throw new Error('不应被调用') }

describe('ask_user 结构化选项', () => {
  it('带选项的问题 → askQuestions 保留题干与选项原文', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: {
        questions: [
          { question: '海报的主题或内容是什么？', options: ['A. 新品 / 产品宣传', 'B. 活动 / 演出宣传'] },
          { question: '两种风格想怎么对比？', options: ['A. 极简留白风 vs 复古印刷风', 'B. 由你自由搭配'] },
        ],
      },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions).toHaveLength(2)
    expect(out.askQuestions![0].question).toBe('海报的主题或内容是什么？')
    expect(out.askQuestions![0].options).toEqual(['A. 新品 / 产品宣传', 'B. 活动 / 演出宣传'])
    expect(out.askQuestions![1].options[1]).toBe('B. 由你自由搭配')
  })

  it('选项里的 "A. " 前缀原样保留（用户手打"选 A"也能对上）', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { questions: [{ question: '要几张？', options: ['A. 1 张', 'B. 4 张'] }] },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions![0].options[0]).toMatch(/^A\./)
  })

  it('参数名容错后的结果同样结构化（question/choices 写法）', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { question: [{ text: '风格？', choices: ['写实', '插画'] }] },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions).toHaveLength(1)
    expect(out.askQuestions![0].question).toBe('风格？')
    expect(out.askQuestions![0].options).toEqual(['写实', '插画'])
  })

  it('纯文字问题（无选项）也结构化，options 为空数组', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { questions: '你想画什么？' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions).toHaveLength(1)
    expect(out.askQuestions![0].options).toEqual([])
  })

  it('有结构化选项时 reply 只留引导语（否则前端卡片+文字渲染两遍）', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { questions: [{ question: '要几张？', options: ['A. 1 张', 'B. 4 张'] }] },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    // 卡片承载问题，reply 不再重复问题与选项
    expect(out.reply).toBe('需要确认几点，麻烦回复一下：')
    expect(out.reply).not.toContain('要几张？')
    expect(out.reply).not.toContain('A. 1 张')
    // 但结构化数据仍在（前端靠它渲染卡片）
    expect(out.askQuestions![0].question).toBe('要几张？')
  })

  it('纯文字问题也有卡片（options 为空）→ reply 依旧只留引导语，不重复', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { questions: '你想画什么？' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    // 题干由卡片承载（前端对空 options 会提示"直接在下方输入框补充"）
    expect(out.askQuestions![0].question).toBe('你想画什么？')
    expect(out.askQuestions![0].options).toEqual([])
    expect(out.reply).toBe('需要确认几点，麻烦回复一下：')
  })

  it('只有 reason、解析不出任何问题 → reply 用 reason 兜底（这时没有卡片，必须靠文字）', async () => {
    const out = await executeAction({
      name: TOOL.askUser,
      args: { reason: '需要知道目标平台才能继续' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions).toBeUndefined()
    expect(out.reply).toContain('需要知道目标平台才能继续')
  })

  it('一个问题都解析不出来 → 不给 askQuestions（前端不渲染空的选择框）', async () => {
    const out = await executeAction({
      name: TOOL.askUser, args: { reason: '需要目标平台' },
      nextIndex: 0, ctx: ctx(), runDeliverable: noRun,
    })
    expect(out.askQuestions).toBeUndefined()
    expect(out.reply).toContain('需要目标平台')
  })
})
