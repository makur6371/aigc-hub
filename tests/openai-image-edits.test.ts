import { describe, it, expect } from 'vitest'
import { OPENAI_IMAGE_EDITS_ADAPTER_SOURCE } from '@/lib/adapters/openai-image-edits'
import { executeAdapterCode } from '@/lib/adapter-runtime'

function loadAdapter() {
  return executeAdapterCode(OPENAI_IMAGE_EDITS_ADAPTER_SOURCE)
}

describe('openai-image-edits adapter', () => {
  const config = { baseUrl: 'https://api.example.invalid/v1', apiKey: 'k', modelName: 'demo-image' }

  it('文生图走 /images/generations（JSON）', () => {
    const built = loadAdapter().buildImageRequest!(config, {
      prompt: 'a cat', width: 1024, height: 1024,
    })
    expect(built.path).toBe('/images/generations')
    expect(built.body).toEqual({ model: 'demo-image', prompt: 'a cat', n: 1, size: '1024x1024' })
    expect(built.multipart).toBeFalsy()
  })

  it('图生图走 /images/edits（multipart + imageFiles）', () => {
    const built = loadAdapter().buildImageRequest!(config, {
      prompt: 'a red cat',
      referenceImages: ['data:image/png;base64,abc', 'https://example.com/a.png'],
    })
    expect(built.path).toBe('/images/edits')
    expect(built.multipart).toBe(true)
    expect(built.imageFiles).toHaveLength(2)
    expect(built.body).toEqual({ model: 'demo-image', prompt: 'a red cat', n: 1 })
  })

  it('参考图上限 4 张', () => {
    const refs = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.png`)
    const built = loadAdapter().buildImageRequest!(config, { prompt: 'p', referenceImages: refs })
    expect(built.imageFiles).toHaveLength(4)
  })

  it('parseImageResponse 兼容 url 与 b64_json', () => {
    const adapter = loadAdapter()
    expect(adapter.parseImageResponse!({ data: [{ url: 'https://a/b.png' }] })).toEqual({ imageUrl: 'https://a/b.png' })
    expect(adapter.parseImageResponse!({ data: [{ b64_json: 'abc' }] })).toEqual({ b64Json: 'abc' })
    expect(adapter.parseImageResponse!({})).toEqual({})
  })

  it('size 格式错误给出可读提示', () => {
    const msg = loadAdapter().mapImageError!(400, { error: { message: 'Invalid value for size: 3:4' } })
    expect(msg).toContain('WIDTHxHEIGHT')
  })
})
