import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 候选降级链的上下文预算必须取**最小**窗口 —— 回归防护。
 *
 * 真实事故风险（2026-10-04 发现）：原实现取候选里**最大**的窗口。
 * 候选是一条降级链，主模型失败会依次往下试：
 *   主  GLM-5.3-Flash     1M      ← 按它算 → 装 80 万字符历史
 *   备  Qwen3.8-Flash-Next 248K   ← 降级到它 → 80 万字符装不下 → 上游 400
 * 「降级」本来是为了容错，结果变成必炸。取最小则链上哪个模型都装得下。
 *
 * 这条用「读源码断言」而不是跑运行时：预算计算在循环/executor 内部，
 * 要跑起来需要 mock 大量依赖；而这个错误的形态很明确（max vs min），静态锁住更划算。
 */
describe('候选降级链 —— 上下文预算取最小窗口', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', 'src', 'lib', f), 'utf8')

  it('agent-tool-loop 取最小（不是最大）', () => {
    const src = read('agent-tool-loop.ts')
    // 不得再出现「比 max 大就替换」的写法
    expect(src).not.toMatch(/c\.contextWindow\s*>\s*\(mx/)
    // 必须是与 Infinity 比较的取最小写法
    expect(src).toMatch(/c\.contextWindow\s*<\s*\(mn\s*\?\?\s*Infinity\)/)
  })

  it('agent-executor（回落路径）同样取最小', () => {
    const src = read('agent-executor.ts')
    expect(src).not.toMatch(/c\.contextWindow\s*>\s*\(mx/)
    expect(src).toMatch(/c\.contextWindow\s*<\s*\(mn\s*\?\?\s*Infinity\)/)
  })
})
