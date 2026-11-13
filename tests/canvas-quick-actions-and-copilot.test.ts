import { describe, it, expect } from 'vitest'
import { parseCopilotResponse, buildCopilotSystemPrompt } from '@/lib/copilot-actions'

describe('Canvas Copilot & Quick Actions 架构增强', () => {
  it('parseCopilotResponse —— 正确解析包含 autoLayout 的 actions', () => {
    const rawJson = JSON.stringify({
      thought: '搭建好图片转视频流，整理排版',
      reply: '已为您连接图生视频节点，并优化画布排版',
      actions: [
        { op: 'createNode', nodeType: 'video-generate', tempId: 'v1' },
        { op: 'connectNodes', sourceNodeId: 'node-img-1', sourcePort: 'imageUrl', targetNodeId: 'v1', targetPort: 'image' },
        { op: 'autoLayout' },
      ],
      status: 'done',
    })

    const res = parseCopilotResponse(rawJson)
    expect(res.reply).toBe('已为您连接图生视频节点，并优化画布排版')
    expect(res.actions).toHaveLength(3)
    expect(res.actions[2]).toEqual({ op: 'autoLayout' })
  })

  it('buildCopilotSystemPrompt —— 提示词中包含 autoLayout 规范', () => {
    const prompt = buildCopilotSystemPrompt([], [])
    expect(prompt).toContain('autoLayout')
    expect(prompt).toContain('自动整理画布节点布局')
  })
})
