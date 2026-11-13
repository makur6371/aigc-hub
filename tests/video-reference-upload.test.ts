import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SlotControl } from '@/app/(app)/tools/[slug]/slot-controls'
import { executeNode, resolveInputs, type ExecutionNode, type NodeContext } from '@/lib/canvas-executor'
import { generateVideo } from '@/lib/media-provider'
import { buildRuns } from '@/lib/tool-run-plan'

vi.mock('@/lib/media-provider', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/media-provider')>(),
  generateVideo: vi.fn(async () => ({ videoUrl: 'https://example.com/result.mp4' })),
}))

const videoSlot = {
  id: 'upload:video', type: 'upload', label: '参考视频', accept: ['video'],
  videoModeOnly: 'multiReference', targets: [{ nodeId: 'video', port: 'video' }],
} as const
const slot = { ...videoSlot, accept: [...videoSlot.accept], targets: [...videoSlot.targets] }
const audioSlot = {
  id: 'upload:audio', type: 'upload' as const, label: '参考音频',
  targets: [{ nodeId: 'audio', port: 'audio' }],
}
const videos = ['https://example.com/first.mp4', 'https://example.com/second.mp4', 'https://example.com/third.mp4']
const audios = ['https://example.com/first.mp3', 'https://example.com/second.mp3']
const metadata = (maxVideos: number) => ({ video: { constraints: { maxVideos, maxAudios: 3 } } })

describe('全能参考上传', () => {
  it('旧槽位按所选模型开启多选，达到上限后保留素材并停止添加', () => {
    const render = (maxVideos: number, value?: string[]) => renderToStaticMarkup(createElement(SlotControl, {
      slot, value, videoMode: 'multiReference', selectedModelId: 'model',
      models: [{ id: 'model', name: 'Video Model', type: 'VIDEO', metadata: metadata(maxVideos) }],
      message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
      onChange: vi.fn(),
    }))
    expect(render(3)).toMatch(/<input[^>]+multiple=""/)
    expect(render(3, videos)).toMatch(/<input[^>]+disabled=""/)
    expect(render(3, videos)).toContain('已传 3/3')
    expect(render(1)).not.toMatch(/<input[^>]+multiple=""/)
    expect(render(0)).toBe('')
  })

  it('整批素材经过上传节点和连线，保序进入一次生成请求；超限在扣豆前拦截', async () => {
    const nodes: ExecutionNode[] = [
      { id: 'video', type: 'video-upload', label: '参考视频', category: 'input', inputs: {}, outputs: {} },
      { id: 'audio', type: 'audio-upload', label: '参考音频', category: 'input', inputs: {}, outputs: {} },
      { id: 'generate', type: 'video-generate', label: '生成视频', category: 'generate', inputs: { prompt: 'Make a video' }, outputs: {} },
    ]
    const connections = [
      { id: 'video', sourceNodeId: 'video', sourcePort: 'video', targetNodeId: 'generate', targetPort: 'referenceVideo' },
      { id: 'audio', sourceNodeId: 'audio', sourcePort: 'audio', targetNodeId: 'generate', targetPort: 'referenceAudio' },
    ]
    const runs = buildRuns(nodes, connections, [slot, audioSlot], { [slot.id]: videos, [audioSlot.id]: audios })
    expect(runs).toHaveLength(1)
    const [video, audio, generate] = runs[0].nodes
    const ctx = {
      userId: 'user', emit: vi.fn(), deductBeans: vi.fn(),
      findModel: vi.fn(async () => ({
        id: 'model', modelName: 'test-video', type: 'VIDEO', videoCost: 10, metadata: metadata(3),
        provider: { baseUrl: 'https://example.com', apiKey: 'test' },
      })),
    } as unknown as NodeContext
    const outputs = {
      video: await executeNode(video, video.inputs, ctx),
      audio: await executeNode(audio, audio.inputs, ctx),
    }
    const inputs = resolveInputs(generate, connections, outputs)
    await executeNode(generate, inputs, ctx)
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      extras: { referenceVideos: videos, referenceAudios: audios },
    }))
    expect(generateVideo).toHaveBeenCalledTimes(1)
    expect(ctx.deductBeans).toHaveBeenCalledTimes(1)

    await expect(executeNode(generate, {
      ...inputs, referenceVideo: [...videos, 'https://example.com/fourth.mp4'],
    }, ctx)).rejects.toThrow('最多 3 段参考视频')
    expect(ctx.deductBeans).toHaveBeenCalledTimes(1)
    expect(generateVideo).toHaveBeenCalledTimes(1)
  })
})
