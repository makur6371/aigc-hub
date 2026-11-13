import { describe, it, expect } from 'vitest'
import {
  normalizeExecuteMode,
  type AgentExecuteMode,
} from '@/lib/agent-preferences'
import {
  shouldGateActions,
  toPendingAction,
  queuedToolText,
  actionKindOf,
} from '@/lib/agent-pending'
import { normalizePendingActions, messageFromHistoryRecord, planFromSubtasks } from '@/lib/agent-message'
import type { AgentDeliverable } from '@/lib/agent-plan'

// 「执行前确认」是一个动钱开关：confirm 时必须真的拦住执行、把方案落库等确认。
// 这里锁住三件容易写错、且错了会直接伤钱/伤体验的事：
//   1) 模式归一化：只有显式 confirm 才拦（脏值一律回落 auto，不能把用户卡住）
//   2) 待确认项必须带完整 prompt（让用户确认看不到内容的动作毫无意义）
//   3) 落库/回显链路（历史重开也要能看到确认卡）

describe('normalizeExecuteMode —— 只有显式 confirm 才拦', () => {
  it('confirm 原样', () => {
    expect(normalizeExecuteMode('confirm')).toBe('confirm')
  })
  it('未知/脏值/缺省一律回落 auto（宁可少拦，也不能卡住用户）', () => {
    for (const v of [undefined, null, '', 'auto', 'CONFIRM', 'yes', 1, {}, []]) {
      expect(normalizeExecuteMode(v), String(v)).toBe('auto')
    }
  })
})

describe('shouldGateActions —— 闸门判定', () => {
  it('仅 confirm 触发闸门', () => {
    expect(shouldGateActions('confirm')).toBe(true)
    expect(shouldGateActions('auto')).toBe(false)
    expect(shouldGateActions(undefined)).toBe(false)
    expect(shouldGateActions(null)).toBe(false)
    // 脏值不能误拦
    expect(shouldGateActions('CONFIRM')).toBe(false)
  })
})

describe('toPendingAction —— 确认卡要能看到完整方案', () => {
  const d: AgentDeliverable = {
    id: 'task-0', title: '主图', type: 'image', model: 'm1',
    prompt: '白色背景，产品居中，柔和阴影', count: 3, ratio: '1:1', quality: '2K',
  }
  it('完整提示词、张数、参数都带出来（用户确认的就是这份）', () => {
    const p = toPendingAction(d, 0)
    expect(p.prompt).toBe('白色背景，产品居中，柔和阴影')
    expect(p.count).toBe(3)
    expect(p.ratio).toBe('1:1')
    expect(p.quality).toBe('2K')
    expect(p.kind).toBe('image')
    expect(p.modelId).toBe('m1')
  })
  it('没有 id 时兜底一个稳定 key（避免确认卡 key 冲突）', () => {
    expect(toPendingAction({ ...d, id: undefined }, 2).id).toBe('pending-2')
  })
  it('张数夹到 1..8（与执行期的上限同口径）', () => {
    expect(toPendingAction({ ...d, count: 99 }, 0).count).toBe(8)
    expect(toPendingAction({ ...d, count: 0 }, 0).count).toBe(1)
  })
  it('类型映射覆盖四类', () => {
    expect(actionKindOf('image')).toBe('image')
    expect(actionKindOf('video')).toBe('video')
    expect(actionKindOf('audio')).toBe('audio')
    expect(actionKindOf('text')).toBe('text')
  })
  it('回填给模型的文案要明确「未执行、别重复提交」', () => {
    const t = queuedToolText(toPendingAction(d, 0))
    expect(t).toContain('待确认')
    expect(t).toContain('暂未生成')
    expect(t).toContain('不要')
  })
})

describe('normalizePendingActions —— 前端只认能看清内容的项', () => {
  it('没有 prompt 的项直接丢弃', () => {
    const list = normalizePendingActions([
      { kind: 'image', title: 'A', prompt: '  ' },
      { kind: 'image', title: 'B', prompt: '有内容的提示词' },
    ])
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('B')
  })
  it('脏字段归一化（count/kind 非法值）', () => {
    const [p] = normalizePendingActions([{ kind: 'weird', prompt: 'x', count: 'abc' }])
    expect(p.kind).toBe('text')
    expect(p.count).toBe(1)
    expect(p.title).toBe('第 1 步')
  })
  it('预估花费只有有限数才带出（NaN/Infinity 不显示）', () => {
    const [p] = normalizePendingActions([{ prompt: 'x', estimate: { points: NaN, beans: 12 } }])
    expect(p.estimate).toEqual({ points: null, beans: 12 })
  })
})

describe('历史回显 —— 刷新/重开会话仍能看到确认卡', () => {
  it('meta.pendingActions 会被还原', () => {
    const msg = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: '请确认', status: 'DONE',
      meta: { taskId: 't1', pendingActions: [{ kind: 'image', title: '主图', prompt: 'P', count: 2 }] },
    })
    expect(msg.pendingActions).toHaveLength(1)
    expect(msg.pendingActions?.[0].title).toBe('主图')
    expect(msg.pendingTaskId).toBe('t1')
  })
})

describe('修订循环 —— 用户说人话，Agent 重排', () => {
  it('revisionRound 会随历史回显带出（用户要能看到「第 N 版」）', () => {
    const msg = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: '请确认', status: 'DONE',
      meta: { taskId: 't1', revisionRound: 2, pendingActions: [{ kind: 'image', title: 'A', prompt: 'P' }] },
    })
    expect(msg.revisionRound).toBe(2)
  })

  it('脏 revisionRound（0/负数/NaN/字符串）不展示版本徽标', () => {
    for (const bad of [0, -1, NaN, '2', null, undefined]) {
      const msg = messageFromHistoryRecord({
        id: 'm1', role: 'assistant', content: 'x', status: 'DONE',
        meta: { taskId: 't1', revisionRound: bad, pendingActions: [{ prompt: 'P' }] },
      })
      expect(msg.revisionRound, String(bad)).toBeUndefined()
    }
  })

  it('修订后的新方案会被回显（不是第一版）', () => {
    const msg = messageFromHistoryRecord({
      id: 'm1', role: 'assistant', content: 'x', status: 'DONE',
      meta: {
        taskId: 't1', revisionRound: 1,
        pendingActions: [{ kind: 'image', title: '暖色调版', prompt: '暖色调', count: 2 }],
      },
    })
    expect(msg.pendingActions?.[0].title).toBe('暖色调版')
    expect(msg.pendingActions?.[0].count).toBe(2)
  })
})

/**
 * 确认执行后的三条链路（本次线上 bug 的完整复盘）。
 *
 * 用户报的两个症状：
 *   1) 出现一个「小板儿」（确认卡旁边一张全红的执行计划卡）
 *   2) 成果区看不到派发，生成完也没有图
 *
 * 根因是同一个：confirm 是**独立后台请求**，/send 那条 SSE 流的 emit 不存在，
 * 执行期的 subtask/media 事件全被丢掉 —— 图其实生成好了（生产实库确认
 * generationTask.result 里有真实 imageUrls），只是没人把它送回界面。
 */
describe('确认执行的产物链路', () => {
  it('pending 不能渲染成 failed（「小板儿」的根因）', () => {
    const plan = planFromSubtasks([
      { id: 'task-0', title: '主图', type: 'image', status: 'pending' },
    ])
    expect(plan?.steps[0].status).toBe('pending')
    // 回归：以前非 success/running 一律当 failed → 卡片整片变红
    expect(plan?.steps[0].status).not.toBe('failed')
  })

  it('success / failed / running 的映射不被这次改动破坏', () => {
    const plan = planFromSubtasks([
      { title: 'A', status: 'success' },
      { title: 'B', status: 'failed' },
      { title: 'C', status: 'running' },
      { title: 'D', status: '莫名其妙的值' },
    ])
    expect(plan?.steps.map((x) => x.status)).toEqual(['success', 'failed', 'running', 'failed'])
  })
})
