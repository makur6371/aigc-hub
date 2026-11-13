import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * undici 默认超时放宽（2026-10-03 生产事故根因守卫）。
 *
 * 事故：用户反馈「生图等 5 分钟就断」。查 api_usage_logs 发现大量失败
 * durationMs 卡在 301_000~327_000，报 UND_ERR_HEADERS_TIMEOUT ——
 * 这不是业务超时（IMAGE_TIMEOUT_MS = 900s），而是 Node 内置 fetch
 * （undici）自己的默认值 headersTimeout = 300_000（5 分钟）。
 * 业务超时被底层抢跑，且错误文案与真实原因不符。
 *
 * 修法：instrumentation.ts 里 setGlobalDispatcher 抬高 headersTimeout/bodyTimeout。
 * 验证以下两项：
 *   ① instrumentation.ts 存在且确实设了这两个值
 *   ② 用了 NEXT_RUNTIME 守卫（Edge runtime 没有 undici）
 */

const root = resolve(__dirname, '..')
const instrPath = resolve(root, 'src/instrumentation.ts')

describe('undici 全局超时放宽', () => {
  it('instrumentation.ts 存在', () => {
    expect(existsSync(instrPath)).toBe(true)
  })

  it('设置了 headersTimeout / bodyTimeout（对齐业务 15 分钟）', () => {
    const src = readFileSync(instrPath, 'utf8')
    expect(src).toContain('setGlobalDispatcher')
    expect(src).toMatch(/headersTimeout/)
    expect(src).toMatch(/bodyTimeout/)
    // 必须显著大于 undici 默认的 300_000，否则改了等于没改
    const headerMatch = src.match(/HEADERS_TIMEOUT_MS\s*=\s*([\d_]+)/)
    expect(headerMatch).toBeTruthy()
    const headerMs = Number(headerMatch![1].replace(/_/g, ''))
    expect(headerMs).toBeGreaterThan(300_000)
  })

  it('用 NEXT_RUNTIME 守卫（Edge runtime 没有 undici）', () => {
    const src = readFileSync(instrPath, 'utf8')
    expect(src).toContain("process.env.NEXT_RUNTIME !== 'nodejs'")
  })

})
