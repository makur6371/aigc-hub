import { describe, it, expect } from 'vitest'
import { buildImageStages, type StageItem } from '@/components/ui/StageFlow'

/**
 * 阶段流程条 —— 动态段数。
 * 关键：没有 LLM 的任务不该出现「优化提示词」；失败要有失败段；已发出才显示「创作中」。
 */
const labels = (s: StageItem[]) => s.map((x) => x.label)

describe('buildImageStages', () => {
  it('无 LLM（纯生图）：只有「排队中 → 创作中」，不出现提示词段', () => {
    const s = buildImageStages({ phase: 'running', status: 'running' })
    expect(labels(s)).toEqual(['排队中', '创作中'])
    expect(labels(s).some((l) => l.includes('提示词'))).toBe(false)
  })

  it('LLM 仍在跑：首段「优化提示词中」为 active', () => {
    const s = buildImageStages({ llmStage: 'running', status: 'running' })
    expect(s[0]).toMatchObject({ label: '优化提示词中', state: 'active' })
  })

  it('LLM 已结束：首段转为「已理解需求」done', () => {
    const s = buildImageStages({ llmStage: 'done', phase: 'queued', status: 'running' })
    expect(s[0]).toMatchObject({ label: '已理解需求', state: 'done' })
    expect(s[1]).toMatchObject({ label: '排队中', state: 'active' })
  })

  it('AI 写分镜：跑的时候只显示「AI 写分镜中」，不会同时亮生图阶段', () => {
    const s = buildImageStages({
      llmStage: 'running',
      llmStageLabel: { running: 'AI 写分镜中', done: '已写分镜' },
      phase: 'running',
      status: 'running',
    })
    expect(s).toEqual([{ label: 'AI 写分镜中', state: 'active' }])
  })

  it('AI 写分镜完成：显示「已写分镜」，再进入排队/创作', () => {
    const s = buildImageStages({
      llmStage: 'done',
      llmStageLabel: { running: 'AI 写分镜中', done: '已写分镜' },
      phase: 'running',
      status: 'running',
    })
    expect(labels(s)).toEqual(['已写分镜', '排队中', '创作中'])
  })

  it('已发出：排队中 done + 创作中 active', () => {
    const s = buildImageStages({ phase: 'running', status: 'running' })
    expect(s).toEqual([
      { label: '排队中', state: 'done' },
      { label: '创作中', state: 'active' },
    ])
  })

  it('刚建占位（无相位）：排队中为当前段，不出现空白', () => {
    const s = buildImageStages({ status: 'running' })
    expect(s).toEqual([{ label: '排队中', state: 'active' }])
  })

  it('失败：以「生成失败」收尾（不再显示创作中）', () => {
    const s = buildImageStages({ llmStage: 'done', phase: 'running', status: 'error' })
    expect(s[s.length - 1]).toEqual({ label: '生成失败', state: 'failed' })
    expect(labels(s)).not.toContain('创作中')
  })

  it('完成：各段均为 done', () => {
    const s = buildImageStages({ phase: 'running', status: 'done' })
    expect(s.every((x) => x.state === 'done')).toBe(true)
    expect(labels(s)).toContain('创作完成')
  })
})
