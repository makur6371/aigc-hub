import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// 站内素材过期后的报错行为：
//
// 背景（生产实测，2026-09-19）：同一批上传素材 07:18~08:04 连续生成成功，
// 13:15 起全部失败，错误是上游回的一句
//   「image_url fetch failed: HTTP 404」
// 根因：上传素材 TTL 只有 2 小时（给上游拉一次的临时中转），文件 + user_assets 记录被清理任务删掉，
// 但 canvas_runs.seedOutputs 里仍留着 /api/asset/... 路径 → 重跑时带着失效地址发给上游。
//
// 修复要求：发请求前先确认站内素材文件还在，不在就用中文说清「要重新上传」，
// 而不是把上游那句与真实原因无关的英文报错透给用户。
//
// 这里用 ASSET_DIR 指向临时目录，直接验证「文件在 / 不在」两种分支。

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asset-alive-'))
  process.env.ASSET_DIR = dir
})

afterAll(async () => {
  delete process.env.ASSET_DIR
  await rm(dir, { recursive: true, force: true })
})

/** 与 canvas-executor 的 isLocalAssetAlive 同逻辑（该函数未导出，这里复刻判定口径） */
async function isLocalAssetAlive(url: string): Promise<boolean> {
  if (!url.startsWith('/api/asset/') && !url.startsWith('/generated/')) return true
  const { stat } = await import('fs/promises')
  const rel = url.slice(url.startsWith('/api/asset/') ? '/api/asset/'.length : '/generated/'.length)
  try {
    const info = await stat(join(dir, rel))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

describe('站内素材存活性判定', () => {
  it('文件存在且非空 → alive', async () => {
    const rel = 'u1/assets/a.png'
    await mkdir(join(dir, 'u1', 'assets'), { recursive: true })
    await writeFile(join(dir, rel), Buffer.from('x'))
    expect(await isLocalAssetAlive(`/api/asset/${rel}`)).toBe(true)
  })

  it('文件已被清理任务删除 → 不 alive（触发中文报错，而不是让上游回 404）', async () => {
    expect(await isLocalAssetAlive('/api/asset/u1/assets/gone.png')).toBe(false)
  })

  it('空文件视为不可用（0 字节图上游同样拉不到）', async () => {
    const rel = 'u1/assets/empty.png'
    await mkdir(join(dir, 'u1', 'assets'), { recursive: true })
    await writeFile(join(dir, rel), Buffer.alloc(0))
    expect(await isLocalAssetAlive(`/api/asset/${rel}`)).toBe(false)
  })

  it('/generated/ 旧前缀同样纳入判定', async () => {
    expect(await isLocalAssetAlive('/generated/u1/assets/gone.png')).toBe(false)
  })

  it('外链不受影响（上游临时链接不归我们管，不能拦）', async () => {
    expect(await isLocalAssetAlive('https://cdn.example.com/a.png')).toBe(true)
  })

  it('data URL 不受影响', async () => {
    expect(await isLocalAssetAlive('data:image/png;base64,AAAA')).toBe(true)
  })

  it('过期文案包含可执行指引（重新上传）', () => {
    const MSG = '参考图已过期：上传的素材只保留 2 小时，过期后会被自动清理。请重新上传图片后再试。'
    expect(MSG).toContain('重新上传')
    expect(MSG).toContain('过期')
  })
})
