import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Agent 结果必须落库（与连接是否存活解耦）—— 防回归
 *
 * 真实现象（2026-10-01 用户报告）：
 *   「刷新浏览器或发生中断，这边显示失败了，但其实它还在生成，只是已经拿不到结果了」
 *
 * 根因链（已用代码 + 生产数据核实）：
 *   1) Agent 是纯 SSE 流（fetch + ReadableStream），连接即生命线
 *   2) ToolAgentPanel 没有卸载清理（不主动 abort），但刷新/切页时连接会被浏览器断
 *   3) agent/send 检测到 request.signal.aborted → 写 CANCELLED → **直接 return**
 *      → 后面「写 SUCCEEDED + result」的整段代码被跳过
 *   4) 而 agent 不写 CanvasRun（生产 canvas_runs 的 surface 只有 canvas/tool/batch）
 *      → 结果**没有任何落脚点**，前端刷新后无从认领
 *   5) 但执行器不监听 signal，图照样生成、积分照样扣 → **钱花了、图丢了、还显示失败**
 *
 * 修法：让「执行完成 → 写库」这一步与流无关。
 *
 * ⚠️ 但有一个不能破坏的既有行为：agent-executor 会**轮询 generationTask.status
 * 来感知取消**（tryRun 里读 CANCELLED）。所以断开时**不能**写 CANCELLED
 * （那会被误判成「用户取消了」而真的中止执行）—— 断开 ≠ 取消。
 */
const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('Agent 结果落库与连接解耦', () => {
  const route = read('app/api/agent/send/route.ts')

  it('断开时不写 CANCELLED（会被执行器误判为用户取消而中止）', () => {
    // 断开分支里不应再把状态置为 CANCELLED
    const detachedBlock = route.slice(route.indexOf('request.signal?.aborted') - 400, route.indexOf('request.signal?.aborted') + 900)
    expect(detachedBlock).not.toMatch(/status:\s*'CANCELLED'/)
  })

  it('执行完成后无论流是否还在，都要落结果（不能只靠 finish() 前的分支）', () => {
    // 落库逻辑必须存在且覆盖 subtasks
    expect(route).toMatch(/prisma\.generationTask\.(update|upsert)/)
    expect(route).toMatch(/subtasks/)
  })

  it('执行器保留了「读任务状态感知取消」的能力（不能被本次改动删掉）', () => {
    const ex = read('lib/agent-executor.ts')
    expect(ex).toMatch(/generationTask\.findUnique/)
    expect(ex).toMatch(/CANCELLED/)
  })

  it('带取消感知的执行路径仍需兼容（tryRun 里仍读任务状态）', () => {
    const ex = read('lib/agent-executor.ts')
    expect(ex).toMatch(/curTask\.status === 'CANCELLED'/)
  })
})
