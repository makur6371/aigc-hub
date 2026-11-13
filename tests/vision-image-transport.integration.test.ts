import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('同一份已上传原图：LLM 收到压缩 JPEG，生图仍收到原图公网 URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vision-transport-'))
  vi.stubEnv('ASSET_DIR', directory)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://site.example')
  const { prepareLlmReferenceImages, publicizeReferenceImages } = await import('@/lib/upstream-image')
  const source = await sharp({
    create: { width: 1920, height: 1080, channels: 4, background: '#663399' },
  }).png().toBuffer()
  const path = join(directory, 'product.png')
  const reference = '/api/asset/product.png'
  try {
    await writeFile(path, source)
    const [vision] = await prepareLlmReferenceImages([reference])
    expect(vision).toMatch(/^data:image\/jpeg;base64,/)
    const metadata = await sharp(Buffer.from(vision.split(',')[1], 'base64')).metadata()
    expect(metadata).toMatchObject({ format: 'jpeg', width: 1280, height: 720 })
    expect(await publicizeReferenceImages([reference], 'user')).toEqual(['https://site.example' + reference])
    expect(await sharp(path).metadata()).toMatchObject({ format: 'png', width: 1920, height: 1080 })
  } finally {
    await rm(path, { force: true })
    await rmdir(directory)
  }
})
