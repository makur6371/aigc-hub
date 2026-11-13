import { describe, it, expect } from 'vitest'
import { analyzeToolSlots } from '@/lib/tool-slots'

/**
 * 工具槽位识别 —— 锁「生视频」类工具的 slot 生成正确性。
 *
 * 为什么测：工具面板的控件（上传/模型/画幅/结果）全靠 analyzeToolSlots 从
 * workflow 快照推导。推错了 → 面板缺控件或结果不展示，且是「静默错误」。
 */

const VG = (id: string, inputs: Record<string, unknown> = {}) => ({
  id, type: 'video-generate', label: '生成视频', inputs: { prompt: '', aspectRatio: '16:9', model: '', ...inputs },
})
const UP = (id: string, type = 'image-upload') => ({ id, type, label: '图', inputs: {} })

describe('analyzeToolSlots —— 文生视频', () => {
  it('生成模型槽（VIDEO）+ 画幅槽 + 结果槽', () => {
    const r = analyzeToolSlots([VG('v1')], [])
    const kinds = r.slots.map((s) => s.type)
    expect(kinds).toContain('model')
    expect(kinds).toContain('ratio')
    expect(kinds).toContain('result')
    const model = r.slots.find((s) => s.type === 'model')
    expect(model?.modelType).toBe('VIDEO')
    const result = r.slots.find((s) => s.type === 'result')
    expect(result?.targets.some((t) => t.port === 'videoUrl')).toBe(true)
  })
})

describe('analyzeToolSlots —— 图生视频', () => {
  it('上传图 → 视频节点：有 upload 槽，结果口是 videoUrl', () => {
    const r = analyzeToolSlots(
      [UP('up1'), VG('v1')],
      [{ sourceNodeId: 'up1', sourcePort: 'imageUrl', targetNodeId: 'v1', targetPort: 'image' }],
    )
    expect(r.slots.some((s) => s.type === 'upload')).toBe(true)
    const result = r.slots.find((s) => s.type === 'result')
    expect(result?.targets.some((t) => t.port === 'videoUrl')).toBe(true)
  })
})

describe('analyzeToolSlots —— 多图参考生视频', () => {
  it('批量上传 → referenceImage：upload 槽允许多张，结果口仍是 videoUrl', () => {
    const r = analyzeToolSlots(
      [UP('up1', 'image-upload-batch'), VG('v1')],
      [{ sourceNodeId: 'up1', sourcePort: 'images', targetNodeId: 'v1', targetPort: 'referenceImage' }],
    )
    const upload = r.slots.find((s) => s.type === 'upload')
    expect(upload).toBeTruthy()
    expect(upload?.multiple).toBe(true)
    const result = r.slots.find((s) => s.type === 'result')
    expect(result?.targets.some((t) => t.port === 'videoUrl')).toBe(true)
  })
})
