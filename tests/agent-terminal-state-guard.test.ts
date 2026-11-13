import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

/**
 * Q-D05 / Q-D06 源码守卫：Agent 任务终态落库必须用「条件写」。
 *
 * 「先读 status 再无条件 update」在读取与写入的间隙会被用户取消穿透：
 * CANCELLED 被覆盖成 SUCCEEDED/FAILED，或 retry 双击重置两次导致双重扣费。
 * 结构契约：send / confirm / resume 的终态写必须是 updateMany + status notIn ['CANCELLED']；
 * retry 的认领必须是 updateMany where status = 'FAILED'（双击只有一方成功）。
 */

// 统一走 helper：换行归一 + 读不到/读空即失败，避免「读到空串 → 负向断言永远绿」
const read = (p: string) => readSource(p)

describe('Agent 任务终态条件写守卫（Q-D05/Q-D06）', () => {
  it('send 路由：SUCCEEDED 与 FAILED 终态都是 notIn CANCELLED 的条件写', () => {
    const src = read('src/app/api/agent/send/route.ts')
    expect(src).toContain("notIn: ['CANCELLED']")
    // 终态写必须走 updateMany（update 不支持非唯一 where，退回 update = 无条件写回潮）
    expect(src).toMatch(/generationTask\.updateMany\(\{[\s\S]*?status: 'SUCCEEDED'/)
    expect(src).toMatch(/generationTask\.updateMany\(\{[\s\S]*?status: 'FAILED'/)
  })

  it('confirm 路由：SUCCEEDED 与 FAILED 终态都是条件写', () => {
    const src = read('src/app/api/agent/tasks/[id]/confirm/route.ts')
    expect(src).toContain("notIn: ['CANCELLED']")
    expect(src).toMatch(/generationTask\.updateMany\(\{[\s\S]*?status: 'SUCCEEDED'/)
    expect(src).toMatch(/generationTask\.updateMany\(\{[\s\S]*?status: 'FAILED'/)
  })

  it('resume 路由：FAILED 终态是条件写', () => {
    const src = read('src/app/api/agent/tasks/[id]/resume/route.ts')
    expect(src).toContain("notIn: ['CANCELLED']")
    expect(src).toMatch(/generationTask\.updateMany\(\{[\s\S]*?status: 'FAILED'/)
  })

  it('retry 路由：FAILED → RUNNING 认领是原子的（双击只有一方成功）', () => {
    const src = read('src/app/api/agent/tasks/[id]/retry/route.ts')
    expect(src).toMatch(/updateMany\(\{[\s\S]*?status: 'FAILED'[\s\S]*?status: 'RUNNING'/)
    expect(src).toContain("throw new ApiHandlerError('任务状态已变化")
  })
})
