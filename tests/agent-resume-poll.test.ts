import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSource } from './helpers/source-guard'

/**
 * 「刷新时任务还在跑 → 成果永远看不到」的修复（Q-D47）。
 *
 * ===== 原来的洞 =====
 * `app/api/agent/tasks` 把**在跑的（RUNNING）任务整个过滤掉**，注释写着
 * 「运行中的占位由当轮 SSE 负责；断线后由下一次轮询/重连接住」——
 * 但**那个「下一次轮询」从来不存在**：前端只在挂载时取一次，且只认领 SUCCEEDED。
 * 于是刷新时任务还在跑 ⇒ 客户端**根本不知道有活儿在跑** ⇒ 自然也不会等它跑完。
 *
 * ===== 修法（选「轮询到终态」，不做增量事件流）=====
 * Agent 任务的执行与连接已经解耦（P1：结果照常落库），所以**唯一的缺口就是
 * 「客户端怎么知道该等」**。为此引入事件流（写 TaskEvent + SSE 订阅）是一整套新机制；
 * 而 `/api/agent/tasks` 这个接口**本来就在**，只需要
 *   ① 让它把在跑的任务也返回（带 RUNNING 状态）；
 *   ② 让前端看到有在跑的任务就**持续轮询**到终态再认领。
 * 少做一套机制，行为等价。
 */

describe('接口必须暴露「在跑的任务」，否则前端无从知道该等', () => {
  it('不再过滤掉 RUNNING 的任务', () => {
    const src = readSource('src/app/api/agent/tasks/route.ts')
    // 旧写法：`t.status !== 'RUNNING' || t.updatedAt < staleCutoff` 会把在跑的整个滤掉
    expect(src).not.toMatch(/filter\(\s*\(t\)\s*=>\s*t\.status\s*!==\s*'RUNNING'/)
  })

  it('僵死的（RUNNING 超 30 分钟）仍按失败给 —— 不让用户白等一个死任务', () => {
    const src = readSource('src/app/api/agent/tasks/route.ts')
    expect(src).toContain('STALE_RUN_MS')
    expect(src).toMatch(/status:\s*t\.status === 'RUNNING' && t\.updatedAt < staleCutoff \? 'FAILED' : t\.status/)
    expect(src).toMatch(/stale:\s*t\.status === 'RUNNING' && t\.updatedAt < staleCutoff/)
  })

  it('认领只认「已成功且有成果」的 —— 在跑的任务不会被误认领', () => {
    const src = readSource('src/lib/recoverable-media.ts')
    expect(src).toMatch(/status !== 'success'/)
    const recovery = readSource('src/components/tools/useResultRecovery.ts')
    expect(recovery).toContain('task.results.map')
  })
})

describe('前端必须轮询到终态（而不是只取一次）', () => {
  it('看到在跑的任务就继续轮询', () => {
    const panel = readSource('src/components/tools/useResultRecovery.ts')
    expect(panel).toContain("task.status === 'RUNNING' || task.status === 'PENDING'")
    expect(panel).toContain('setTimeout(recover,')
  })

  it('轮询按活跃状态降频，卸载时清理定时器与监听', () => {
    const panel = readSource('src/components/tools/useResultRecovery.ts')
    expect(panel).toContain('? 5000 : 30000')
    expect(panel).toContain('document.hidden ? 30000 : interval')
    expect(panel).toContain('clearTimeout(timer)')
    expect(panel).toContain('alive = false')
  })

  it('僵死收敛（P4）仍然存在 —— 轮询要有终点', () => {
    const m = readSource('src/lib/maintenance.ts')
    expect(m).toContain('staleRuns')
    expect(m).toMatch(/generationTask\.updateMany/)
  })
})

describe('半成品不许留在仓里（Q-D47 的另一半）', () => {
  it('死端点 /api/agent/events 已删（零调用方，且它承诺的「续传」从来不是流）', () => {
    expect(existsSync(join(process.cwd(), 'src/app/api/agent/events'))).toBe(false)
  })

  it('TaskEvent 表是死表（生产实测 0 行），删表要走部署流程而不是顺手改 schema', () => {
    // 说明：这张表**先留在 schema 里**。原因：Q-D63 之后 `prisma db push` 失败会**阻断启动**，
    // 而「从 schema 删掉一张表」正好会让 db push 想 DROP 它 → 没有 --accept-data-loss 时会拒绝
    // → 部署直接中止。正确顺序是：**先在生产手工 DROP 表，再从 schema 删 model**，
    // 那时 db push 看到两边一致、不会报任何东西。这条留作部署项。
    const schema = readSource('prisma/schema.prisma')
    expect(schema).toContain('model TaskEvent')
  })
})
