import { describe, expect, it } from 'vitest'
import { pickDownloadExt, sniffMediaExt } from '@/lib/download-results'

const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const webpBytes = new Uint8Array([
  ...[0x52, 0x49, 0x46, 0x46], 0, 0, 0, 0, ...[0x57, 0x45, 0x42, 0x50], 0, 0, 0, 0,
])

describe('sniffMediaExt', () => {
  it('按文件头识别真实格式', () => {
    expect(sniffMediaExt(gifBytes)).toBe('.gif')
    expect(sniffMediaExt(pngBytes)).toBe('.png')
    expect(sniffMediaExt(webpBytes)).toBe('.webp')
  })

  it('认不出来的字节返回 null（交给 MIME / URL 兜底）', () => {
    expect(sniffMediaExt(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('pickDownloadExt', () => {
  it('外链被包成 asset-proxy 后路径里没有扩展名 —— 仍按字节存成 .gif', () => {
    const url = `/api/asset-proxy?u=${encodeURIComponent('https://cdn.example.com/anim/1234')}`
    expect(pickDownloadExt({ url, kind: 'image', mime: 'application/octet-stream', bytes: gifBytes }))
      .toBe('.gif')
  })

  it('字节优先于 MIME：上游把 GIF 标成 image/png 也存对', () => {
    expect(pickDownloadExt({ url: 'https://a.com/x', kind: 'image', mime: 'image/png', bytes: gifBytes }))
      .toBe('.gif')
  })

  it('没有字节时按响应 MIME', () => {
    expect(pickDownloadExt({ url: 'https://a.com/blob', kind: 'video', mime: 'video/webm' })).toBe('.webm')
  })

  it('MIME 也不明时退回 URL 扩展名（代理地址会先解开）', () => {
    expect(pickDownloadExt({ url: 'https://a.com/x.jpeg?token=1', kind: 'image', mime: '' })).toBe('.jpeg')
    expect(pickDownloadExt({
      url: `/api/asset-proxy?u=${encodeURIComponent('https://a.com/x.gif')}`,
      kind: 'image',
      mime: '',
    })).toBe('.gif')
  })

  it('全都识别不出来时按模态给默认值', () => {
    expect(pickDownloadExt({ url: 'https://a.com/blob', kind: 'audio', mime: '' })).toBe('.mp3')
    expect(pickDownloadExt({ url: 'blob:https://a.com/1', kind: 'image', mime: '' })).toBe('.png')
  })
})
