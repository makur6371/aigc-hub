import { describe, expect, it } from 'vitest'
import { resolveAgentImageSize } from '@/lib/agent-executor'
import type { AgentDeliverable } from '@/lib/agent-plan'

const image = (patch: Partial<AgentDeliverable>): AgentDeliverable => ({
  title: 'image',
  type: 'image',
  prompt: 'test',
  ...patch,
})

describe('resolveAgentImageSize', () => {
  it('honors the planner quality before the global default tier', () => {
    expect(resolveAgentImageSize(
      image({ ratio: '16:9', quality: '1K' }),
      { defaultTier: '4K' },
      { metadata: { sizes: ['16:9@1K', '16:9@2K'] } },
    )).toMatchObject({ ratio: '16:9', tier: '1K' })
  })

  it('never returns a ratio/tier combination absent from model metadata', () => {
    expect(resolveAgentImageSize(
      image({ ratio: '16:9', quality: '4K' }),
      {},
      { metadata: { sizes: ['16:9@1K', '1:1@4K'] } },
    )).toMatchObject({ ratio: '16:9', tier: '1K' })
  })

  it('uses the model first legal size when planner omitted ratio', () => {
    expect(resolveAgentImageSize(
      image({}),
      {},
      { metadata: { sizes: ['3:4@2K'] } },
    )).toMatchObject({ ratio: '3:4', tier: '2K' })
  })
})
