import { describe, expect, it } from 'vitest'
import { assetContentFileName, sniffImageMime } from '@/lib/asset-store'

describe('asset content addressing', () => {
  it('same bytes produce the same filename', () => {
    const bytes = Buffer.from('same-image-bytes')
    const a = assetContentFileName(bytes, { mime: 'image/png', fileName: 'a.png', type: 'image' })
    const b = assetContentFileName(bytes, { mime: 'image/png', fileName: 'b.png', type: 'image' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}\.png$/)
  })

  it('different bytes produce different filenames', () => {
    expect(assetContentFileName(Buffer.from('a'), { mime: 'image/png', type: 'image' }))
      .not.toBe(assetContentFileName(Buffer.from('b'), { mime: 'image/png', type: 'image' }))
  })

  it('keeps the detected extension so the asset route serves the right MIME', () => {
    expect(assetContentFileName(Buffer.from('x'), { mime: 'video/mp4', type: 'video' })).toMatch(/\.mp4$/)
    expect(assetContentFileName(Buffer.from('x'), { mime: 'audio/mpeg', type: 'audio' })).toMatch(/\.mp3$/)
  })

  it('从字节识别原生 GIF，避免被声明成 image/png 后存成静态首帧', () => {
    const gif = Buffer.from('GIF89a' + '\0'.repeat(20), 'ascii')
    expect(sniffImageMime(gif)).toBe('image/gif')
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('not-an-image'))).toBeNull()
  })
})
