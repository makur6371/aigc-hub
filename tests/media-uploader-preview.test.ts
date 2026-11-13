import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

describe('MediaUploader 本地 blob 预览（Q-403）', () => {
  const src = readSource('src/components/tools/MediaUploader.tsx')

  it('上传中项携带本地预览地址字段', () => {
    expect(src).toContain('previewUrl')
  })

  it('选择文件时为图片/视频生成本地预览（audio 不生成）', () => {
    expect(src).toMatch(/previewUrl: kind !== 'audio' \? URL\.createObjectURL\(f\)/)
  })

  it('上传循环结束后回收预览 blob，防泄漏', () => {
    expect(src).toMatch(/for \(const item of items\) \{[\s\S]*?URL\.revokeObjectURL\(item\.previewUrl\)[\s\S]*?\}/)
  })

  it('上传中的图片/视频卡片用本地预览渲染真实缩略图', () => {
    expect(src).toMatch(/p\.state === 'uploading' && p\.previewUrl && kind === 'image'/)
    expect(src).toMatch(/p\.state === 'uploading' && p\.previewUrl && kind === 'video'/)
    expect(src).toMatch(/<img src=\{p\.previewUrl\}/)
    expect(src).toMatch(/<video src=\{p\.previewUrl\}/)
  })

  it('预览卡片带半透明遮罩 + 加载指示 + 文件名（与既有上传中信息一致）', () => {
    expect(src).toMatch(/bg-black\/35/)
    expect(src).toContain('formatSize(p.size)')
  })
})
