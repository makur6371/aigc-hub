import { describe, expect, it } from 'vitest'
import { isRetryableError } from '@/lib/agent-executor'
import { ChargeRunError } from '@/lib/billing/charge-run'
import { AgentCancelledError } from '@/lib/agent-cancel'

/**
 * Agent 子任务重试分类表（Q-D15）。
 *
 * 为什么单独钉这张表：旧实现靠一份中英文案正则判重试，上游或翻译层改一个字
 * 就会**悄悄换掉重试行为** —— 该重试的不重试（用户白等一次失败），
 * 不该重试的反复重试（每轮都真实预扣再退款）。这里把每条判据写成用例，
 * 任何改动都会显式暴露成测试红，而不是线上资金/体验差异。
 *
 * 注：`PartialDeliverableError` 未导出（模块内部类），其「部分成功不重试」由
 * tests/agent-batch-parallel.test.ts 那类行为测试覆盖，不在本表重复。
 */

/** 造一个带 undici 风格 cause 的错误（真实形态就是 message 只有 "fetch failed"） */
function fetchFailedWith(cause: Record<string, unknown>): Error {
  const err = new Error('fetch failed') as Error & { cause?: unknown }
  err.cause = Object.assign(new Error(String(cause.message ?? 'underlying')), cause)
  return err
}

describe('isRetryableError 分类表', () => {
  it('连接被重置（ECONNRESET）→ 重试', () => {
    expect(isRetryableError(fetchFailedWith({ code: 'ECONNRESET', message: 'socket hang up' }))).toBe(true)
  })

  it('响应头超时（UND_ERR_HEADERS_TIMEOUT）→ 重试', () => {
    expect(isRetryableError(fetchFailedWith({ code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true)
  })

  it('AbortError（name=TimeoutError）→ 重试', () => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    expect(isRetryableError(err)).toBe(true)
  })

  it('cause 被丢的裸 fetch failed → 仍重试（旧行为，别被 transient 默认 false 改掉）', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
  })

  it('DNS 解析失败（ENOTFOUND）→ 不重试（重试不会变好）', () => {
    expect(isRetryableError(fetchFailedWith({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' }))).toBe(false)
  })

  it('TLS 证书问题 → 不重试（配置类）', () => {
    expect(isRetryableError(fetchFailedWith({ code: 'CERT_HAS_EXPIRED' }))).toBe(false)
  })

  it('上游 5xx 与「未返回内容」→ 重试（上游波动）', () => {
    expect(isRetryableError(new Error('上游返回错误 (502): bad gateway'))).toBe(true)
    expect(isRetryableError(new Error('上游未返回图片数据'))).toBe(true)
  })

  it('类型化错误一律不重试', () => {
    expect(isRetryableError(new ChargeRunError('积分不足，本次需 30 积分', 402))).toBe(false)
    expect(isRetryableError(new AgentCancelledError())).toBe(false)
  })

  it('业务/配置类文案 → 不重试', () => {
    for (const msg of ['豆不足，需要 3 豆', 'image 无可用模型，请配置后再试', 'Provider 未配置 API Key', '该模型不存在']) {
      expect(isRetryableError(new Error(msg))).toBe(false)
    }
  })

  it('未知错误 → 保守重试一次（上游波动的历史默认）', () => {
    expect(isRetryableError(new Error('某个我们从没见过的新错误'))).toBe(true)
  })
})
