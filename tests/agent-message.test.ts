import { describe, it, expect } from 'vitest'
import {
  normalizeAskQuestions,
  normalizeDecisions,
  planFromSubtasks,
  resolveVideoPlanSteps,
  messageFromHistoryRecord,
} from '@/lib/agent-message'

describe('异步视频计划状态', () => {
  it('历史提交成功但未生成的视频显示进行中，真实完成后才成功', () => {
    const plan = planFromSubtasks([{ title: '展示', status: 'success', videoPending: true, recordId: 'record' }])!
    expect(plan.steps[0]).toMatchObject({ status: 'running', videoRecordIds: ['record'] })
    expect(resolveVideoPlanSteps(plan.steps, [{ claimedRunId: 'video:record', status: 'done' }])[0].status).toBe('success')
    expect(resolveVideoPlanSteps(plan.steps, [{ claimedRunId: 'video:record', status: 'error' }])[0].status).toBe('failed')
  })

  it('同一计划的多条视频必须全部完成，缺少结果或仍有排队就保持进行中', () => {
    const plan = planFromSubtasks([{ title: '展示', status: 'processing', pendingRecordIds: ['first', 'second'] }])!
    expect(resolveVideoPlanSteps(plan.steps, [{ claimedRunId: 'video:first', status: 'done' }])[0].status).toBe('running')
  })
})

/**
 * 会话消息归一化 —— 回归防护。
 *
 * 背景（真实 bug）：同一个「消息 → 界面模型」映射写了两遍
 * （实时 SSE 一处、历史回显一处），两份实现立刻漂移：
 * 历史那边漏了 decisions / plan，error 被后端写死成 null。
 * 症状：同一个会话，刚聊完有「关键决策」「执行计划」卡片，
 * 刷新或重开历史就只剩一行回复文字。
 *
 * 这里锁住归一化的行为，防止再次分叉。
 */
describe('normalizeAskQuestions', () => {
  it('保留题干与选项', () => {
    expect(normalizeAskQuestions([{ question: '比例？', options: ['1:1', '16:9'] }]))
      .toEqual([{ question: '比例？', options: ['1:1', '16:9'] }])
  })

  it('丢掉没有题干的问题（避免渲染空选择框）', () => {
    expect(normalizeAskQuestions([{ options: ['a'] }, { question: '' }])).toEqual([])
  })

  it('选项去空串；非数组入参返回空', () => {
    expect(normalizeAskQuestions([{ question: 'q', options: ['a', '', null] }])[0].options).toEqual(['a'])
    expect(normalizeAskQuestions(undefined)).toEqual([])
    expect(normalizeAskQuestions('乱七八糟')).toEqual([])
  })
})

describe('normalizeDecisions', () => {
  it('保留 label/value/reason', () => {
    expect(normalizeDecisions([{ label: '模型', value: 'Qwen-Image', reason: '偏好指定' }]))
      .toEqual([{ label: '模型', value: 'Qwen-Image', reason: '偏好指定' }])
  })

  it('reason 缺失补空串（前端不必到处写 ?? ""）', () => {
    expect(normalizeDecisions([{ label: '比例', value: '1:1' }]))
      .toEqual([{ label: '比例', value: '1:1', reason: '' }])
  })

  it('丢掉缺 label 或 value 的条目（避免渲染「模型： undefined」）', () => {
    expect(normalizeDecisions([{ label: '模型' }, { value: 'x' }, { label: '', value: 'y' }])).toEqual([])
  })

  it('value 是数字也转成字符串', () => {
    expect(normalizeDecisions([{ label: '张数', value: 4 }])[0].value).toBe('4')
  })
})

describe('planFromSubtasks', () => {
  it('由 subtasks 还原步骤（title + status）', () => {
    const p = planFromSubtasks([
      { title: '白底主图', status: 'success' },
      { title: '场景图', status: 'failed' },
    ])
    expect(p!.steps).toEqual([
      { label: '白底主图', status: 'success' },
      { label: '场景图', status: 'failed' },
    ])
  })

  it('cancelled 映射成 failed（不能丢步，否则像数据缺失）', () => {
    expect(planFromSubtasks([{ title: 'x', status: 'cancelled' }])!.steps[0].status).toBe('failed')
  })

  it('空数组/非数组 → undefined（不渲染空计划卡）', () => {
    expect(planFromSubtasks([])).toBeUndefined()
    expect(planFromSubtasks(null)).toBeUndefined()
  })
})

describe('messageFromHistoryRecord —— 历史回显必须和实时一致', () => {
  it('读得出 decisions（这是原 bug：历史路径完全没读）', () => {
    const m = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: 'ok', status: 'done', mediaUrls: [],
      meta: { decisions: [{ label: '模型', value: 'Qwen', reason: 'r' }] },
    })
    expect(m.decisions).toEqual([{ label: '模型', value: 'Qwen', reason: 'r' }])
  })

  it('读得出 plan（原 bug：plan 根本没落库，落库后也要读）', () => {
    const m = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: 'ok', status: 'done', mediaUrls: [],
      meta: { subtasks: [{ title: '主图', status: 'success' }] },
    })
    expect(m.plan!.steps[0].label).toBe('主图')
  })

  it('失败原因取自 meta.error（原 bug：接口把 error 写死成 null）', () => {
    const m = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: '', status: 'failed', mediaUrls: [],
      meta: { error: '上游超时' },
    })
    expect(m.error).toBe('上游超时')
    expect(m.status).toBe('failed')
  })

  it('有 error 但 status 是 done 时仍判为 failed（状态以原因兜底）', () => {
    const m = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: '', status: 'done', mediaUrls: [], meta: { error: 'x' },
    })
    expect(m.status).toBe('failed')
  })

  it('用户消息的上传图 + 助手产物合并，顺序为先上传后产物', () => {
    const m = messageFromHistoryRecord({
      id: 'm1', role: 'user', content: 'hi', status: 'done',
      mediaUrls: ['/out.png'], meta: { images: ['/in.png'] },
    })
    expect(m.images).toEqual(['/in.png', '/out.png'])
  })

  it('旧数据兼容：修复前存的消息 meta 里没有 subtasks/decisions，不能崩也不能渲染空卡', () => {
    // 落库是逐步加的：老消息只有 { taskId }。归一化必须容错，否则用户一打开历史就白屏。
    const m = messageFromHistoryRecord({
      id: 'old', role: 'assistant', content: '很久以前的回复', status: 'done',
      mediaUrls: [], meta: { taskId: 't1', mode: 'smart' },
    })
    expect(m.content).toBe('很久以前的回复')
    expect(m.status).toBe('done')
    expect(m.plan).toBeUndefined()
    expect(m.decisions).toBeUndefined()
  })
  it('没有可选字段时不产生空数组（避免渲染空卡片）', () => {
    const m = messageFromHistoryRecord({ id: 'm1', role: 'user', content: 'hi', status: 'done' })
    expect(m.decisions).toBeUndefined()
    expect(m.plan).toBeUndefined()
    expect(m.askQuestions).toBeUndefined()
    expect(m.images).toBeUndefined()
    expect(m.error).toBeUndefined()
  })
})
