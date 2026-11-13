import { describe, it, expect } from 'vitest'
import { validateVideoParams } from '@/lib/billing/billing-plans'
import { getVideoCapabilities } from '@/lib/video-capabilities'

// 视频模型的「需要上传什么 / 可上传什么」必须在**提交上游之前**拦住。
//
// 2026-10-18 用户报的问题：动作迁移工具把参考视频标成「可选」，用户没上传却被
// 上游回「请上传视频」。根因是 maxVideos 只表达**上限**、表达不了「至少 1 个」，
// 于是空值一路提交到上游才失败（此时豆已扣）。
//
// 这里钉住两个不变量：
//   1) requireVideo / requireAudio 能拦住缺失（与 requireImage 同等地位）
//   2) maxVideos=0 表示「不收视频」，不是「视频必填」 —— 两者语义不能混

const model = (constraints: Record<string, unknown>) =>
  ({ id: 'm', name: 'M', modelName: 'm', type: 'VIDEO', metadata: { video: { constraints } } }) as never

describe('视频素材必填校验（requireVideo / requireAudio）', () => {
  it('动作迁移：缺动作视频时拦住，且给出可操作文案', () => {
    const m = model({ ratios: ['16:9'], requireImage: true, requireVideo: true, maxImages: 1, maxVideos: 1 })
    const missingVideo = validateVideoParams(m, { videoCount: 0, imageCount: 1 })
    expect(missingVideo).toBeTruthy()
    expect(missingVideo).toContain('视频')
    // 关键：拦住时不能顺带抱怨图片（图已给了）
    expect(missingVideo).not.toContain('参考图')
  })

  it('动作迁移：图与视频都在时通过', () => {
    const m = model({ ratios: ['16:9'], requireImage: true, requireVideo: true, maxImages: 1, maxVideos: 1 })
    expect(validateVideoParams(m, { imageCount: 1, videoCount: 1 })).toBeNull()
  })

  it('对口型：缺音频时拦住', () => {
    const m = model({ requireImage: true, requireAudio: true, maxImages: 1, maxAudios: 1 })
    const msg = validateVideoParams(m, { imageCount: 1, audioCount: 0 })
    expect(msg).toBeTruthy()
    expect(msg).toContain('音频')
  })

  it('maxVideos=0 是「不收视频」而非「视频必填」—— 语义不能混', () => {
    // 首尾帧工作流就是这种：只收两张图，视频/音频一律不收
    const m = model({ requireImage: true, maxImages: 0, maxAudios: 0 })
    // maxN=0 表示「不声明上限」（首尾帧走 first_frame/last_frame，不走 referenceImages）
    expect(validateVideoParams(m, { imageCount: 2, videoCount: 0, audioCount: 0 })).toBeNull()
  })

  it('maxImages:0 不再把首尾帧工作流判死（2026-10-18 修：上限 0 = 不限制）', () => {
    // 回归：历史上 maxImages:0 被当成「最多 0 张」，首尾帧工作流从来跑不通
    const m = model({ requireImage: true, maxImages: 0 })
    expect(validateVideoParams(m, { imageCount: 2 })).toBeNull()
  })

  it('真正想禁止多图时写 maxImages:1（上限 0 = 不限制 的另一面）', () => {
    const m = model({ maxImages: 1 })
    expect(validateVideoParams(m, { imageCount: 2 })).toContain('最多 1 张参考图')
  })

  it('未声明 requireVideo 的模型（如普通多图生视频）留空视频仍放行', () => {
    const m = model({ maxImages: 9, maxAudios: 3 })
    expect(validateVideoParams(m, { imageCount: 1, videoCount: 0, audioCount: 0 })).toBeNull()
  })
})

describe('getVideoCapabilities 透传新字段', () => {
  it('requireVideo / requireAudio 能从 metadata 解析出来', () => {
    const cap = getVideoCapabilities(model({ requireImage: true, requireVideo: true, requireAudio: true }))
    expect(cap.requireImage).toBe(true)
    expect(cap.requireVideo).toBe(true)
    expect(cap.requireAudio).toBe(true)
  })

  it('未声明时为 false（而不是 undefined，避免各处 if 判断漏判）', () => {
    const cap = getVideoCapabilities(model({ maxImages: 9 }))
    expect(cap.requireVideo).toBe(false)
    expect(cap.requireAudio).toBe(false)
  })
})
