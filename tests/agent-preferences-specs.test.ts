import { describe, expect, it } from 'vitest'
import { validateAgentPreferenceSpecs } from '@/lib/agent-preferences'

describe('validateAgentPreferenceSpecs', () => {
  it('accepts a valid image ratio/tier pair, including legacy pixel sizes', () => {
    expect(validateAgentPreferenceSpecs({
      imageModel: { metadata: { sizes: ['1536x1024'] } },
      imageRatio: '3:2',
      imageTier: '1K',
    })).toBeNull()
  })

  it('rejects a tier that exists globally but is not valid for the selected ratio', () => {
    expect(validateAgentPreferenceSpecs({
      imageModel: { metadata: { sizes: ['16:9@1K', '1:1@4K'] } },
      imageRatio: '16:9',
      imageTier: '4K',
    })).toContain('不支持规格')
  })

  it('rejects a tier without a ratio when the model declares sizes', () => {
    expect(validateAgentPreferenceSpecs({
      imageModel: { metadata: { sizes: ['1:1@1K'] } },
      imageTier: '1K',
    })).toContain('先选择画面比例')
  })

  it('rejects video ratio, resolution and duration outside model constraints', () => {
    const videoModel = {
      metadata: {
        video: {
          constraints: {
            ratios: ['9:16'],
            resolutions: ['720P'],
            durations: [5],
          },
        },
      },
    }
    expect(validateAgentPreferenceSpecs({ videoModel, videoRatio: '16:9' })).toContain('不支持比例')
    expect(validateAgentPreferenceSpecs({ videoModel, videoResolution: '1080P' })).toContain('不支持清晰度')
    expect(validateAgentPreferenceSpecs({ videoModel, videoDuration: 10 })).toContain('不支持 10 秒')
  })

  it('keeps models without declared constraints permissive', () => {
    expect(validateAgentPreferenceSpecs({
      imageModel: { metadata: {} },
      imageRatio: '3:4',
      imageTier: '2K',
      videoModel: { metadata: {} },
      videoRatio: '16:9',
      videoResolution: '1080P',
      videoDuration: 10,
    })).toBeNull()
  })
})
