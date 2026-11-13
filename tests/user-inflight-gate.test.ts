import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

const conc = readSource('src/lib/concurrency.ts')
const invoker = readSource('src/lib/provider-invoker.ts')

describe('用户级在途闸门（Q-D51）', () => {
  it('用户上限是全平台上限的一部分且可关（0 = 关闭，保持旧行为）', () => {
    expect(conc).toMatch(/USER_MAX_INFLIGHT = readInt\('USER_MAX_INFLIGHT', Math\.max\(5, Math\.floor\(MAX_INFLIGHT \/ 3\)\), 0, MAX_INFLIGHT\)/)
    expect(conc).toMatch(/USER_MAX_INFLIGHT > 0/)
  })

  it('按 userId 分桶、桶不复用全局名额（等待发生在自己桶里）', () => {
    expect(conc).toMatch(/userLimiters = new Map/)
    expect(conc).toMatch(/userLimiterOf\(userId\)\(async/)
  })

  it('不传 userId 的调用不占用户名额（第三方/内部调用不受影响）', () => {
    expect(conc).toMatch(/if \(userId && USER_MAX_INFLIGHT > 0\)/)
  })

  it('provider-invoker 的四个上游入口都已透传 userId', () => {
    expect(invoker).toMatch(/withUpstreamGate\(\(\) =>\s*\r?\n?\s*invokeChatOnce\([\s\S]*?,\s*userId,/)
    expect(invoker).toMatch(/invokeImageOnce\(provider, modelName, params, userId, adapter\), userId\)/)
    expect(invoker).toMatch(/invokeVideoOnce\(provider, modelName, params, userId\), userId\)/)
    expect(invoker).toMatch(/invokeAudioOnce\(provider, modelName, params, userId\), userId\)/)
  })

  it('LLM 与感知入口透传链路完整（llm-provider / perception / 各调用方带 userId）', () => {
    const llm = readSource('src/lib/llm-provider.ts')
    expect(llm).toMatch(/userId\?: string,\r?\n\): Promise<ChatResult>/)
    expect(llm).toMatch(/timeoutMs,\s*\r?\n\s*undefined,\s*\r?\n\s*userId,/)
    const canvas = readSource('src/lib/canvas-executor.ts')
    expect(canvas).toMatch(/CHAT_NODE_TIMEOUT_MS,\s*\r?\n\s*ctx\.userId,/)
    expect(canvas).toMatch(/userId: ctx\.userId,\s*\r?\n\s*\}\)\r?\n\r?\n?\s*return \{ text \}/)
    const loop = readSource('src/lib/agent-tool-loop.ts')
    expect(loop).toMatch(/TURN_TIMEOUT_MS,\s*\r?\n\s*userId,/)
  })
})
