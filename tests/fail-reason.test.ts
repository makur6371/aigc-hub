import { describe, it, expect } from 'vitest'
import { humanizeFailReason } from '@/lib/fail-reason'

// 失败原因必须让用户知道「下一步做什么」。
//
// 背景（生产实测）：9/18 一天 55 次失败全是上游回的
// 「非常抱歉，生成的图片可能违反了关于与第三方内容相似性的防护限制。如果你认为此判断有误，请重试或修改提示语。」
// 而成果区只显示一句「生成失败」——用户不知道是素材问题、要重传、还是直接重试就行。
//
// 原则：分类 + 给动作；**认不出来的保留原文**（宁可啰嗦，不能编原因误导用户）。

describe('humanizeFailReason —— 失败原因翻成人话', () => {
  it('上游内容审核（第三方相似性）→ 给出「更换参考图或调整描述」', () => {
    const raw = '上游返回错误 (400): 非常抱歉，生成的图片可能违反了关于与第三方内容相似性的防护限制。如果你认为此判断有误，请重试或修改提示语。'
    const msg = humanizeFailReason(raw)
    expect(msg).toContain('内容审核未通过')
    expect(msg).toContain('更换参考图')
    expect(msg).not.toContain('非常抱歉') // 不再把上游原话甩给用户
  })

  it('上游内容审核（非法或违法 / 内容政策）→ 合规提示', () => {
    expect(humanizeFailReason('上游返回错误 (400): 非常抱歉，生成的图片可能违反了关于非法或违法活动的防护限制。')).toContain('内容审核未通过')
    expect(humanizeFailReason('上游返回错误 (400): 非常抱歉，生成的图片可能违反了我们的内容政策。')).toContain('内容审核未通过')
  })

  it('参考图过期 → 明确说「重新上传」', () => {
    expect(humanizeFailReason('参考图已过期：上传的素材只保留 2 小时，过期后会被自动清理。请重新上传图片后再试。')).toContain('重新上传')
    expect(humanizeFailReason('上游返回错误 (400): image_url fetch failed: HTTP 404')).toContain('重新上传')
  })

  it('上游偶发故障 / 网络中断 → 说「重试即可」', () => {
    expect(humanizeFailReason('上游服务异常: openai_error')).toContain('重试')
    expect(humanizeFailReason('fetch failed')).toContain('重试')
    expect(humanizeFailReason('网络连接中断，请重试 (ECONNRESET)')).toContain('重试')
  })

  it('超时 → 提示可降低清晰度档位（大尺寸出图常见）', () => {
    expect(humanizeFailReason('This operation was aborted')).toContain('超时')
    expect(humanizeFailReason('请求超时（180s）')).toContain('清晰度')
  })

  it('积分不足 → 指向充值', () => {
    expect(humanizeFailReason('积分不足，本次预计消耗 12 积分')).toContain('充值')
  })

  it('认不出来的错误保留原文（不编原因）', () => {
    const raw = '某个我们没见过的上游报错 X-999'
    expect(humanizeFailReason(raw)).toBe(raw)
  })

  it('空字符串原样返回（不写无意义的兜底文案）', () => {
    expect(humanizeFailReason('')).toBe('')
  })
})
