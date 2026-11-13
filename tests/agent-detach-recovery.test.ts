import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 断线后「结果不丢」的配套能力（防回归）
 *
 * 用户报的现象：「刷新或中断后显示失败，但其实还在生成，只是已经拿不到结果了」。
 *
 * 四层修复，任何一层缺失都会退化成原来的问题：
 *   P1 执行与连接解耦（结果照常落库）      → app/api/agent/send/route.ts
 *   P2 认领入口（刷新后能把结果补回来）    → app/api/agent/tasks/route.ts + ToolAgentPanel
 *   P3 浏览器通知（切到别的页也能知道）    → lib/browser-notify.ts
 *   P4 僵死 RUNNING 收敛（否则永远不显示 + 预扣退不回）→ lib/maintenance.ts
 */
const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('断线后结果不丢（P1–P4）', () => {
  it('P1: agent/send 把执行抽成与流无关的 runJob（落库不再被断开跳过）', () => {
    const route = read('app/api/agent/send/route.ts')
    expect(route).toContain('const runJob =')
    // 断开分支必须存在且**不写 CANCELLED**（会被执行器误判成用户取消）
    expect(route).toContain('clientGone')
    const detach = route.slice(route.indexOf('clientGone'), route.indexOf('clientGone') + 400)
    expect(detach).not.toMatch(/status:\s*'CANCELLED'/)
  })

  it('P1: 流只做事件转发（listeners 广播），断开时只摘掉自己而不中止任务', () => {
    const route = read('app/api/agent/send/route.ts')
    expect(route).toContain('listeners')
    expect(route).toMatch(/listeners\.delete\(send\)/)
    expect(route).toContain("'abort'")
  })

  it('P2: 存在 Agent 任务认领接口，且从 payload.subtasks 抽成果', () => {
    const api = read('app/api/agent/tasks/route.ts')
    expect(api).toContain('extractResults')
    expect(api).toMatch(/subtasks/)
    expect(api).toContain('taskType: \'agent\'')
    // 只认成功项 —— 失败/取消不该进成果区
    expect(read('lib/recoverable-media.ts')).toMatch(/status !== 'success'/)
  })

  it('P2: 工作台统一恢复各入口任务，并按 URL 去重（不依赖 Agent 面板）', () => {
    expect(read('components/tools/ToolStudio.tsx')).toContain('useResultRecovery()')
    const recovery = read('components/tools/useResultRecovery.ts')
    expect(recovery).toContain('/api/results/recovery')
    expect(recovery).toContain('mergeRecoveredResults(')
  })

  it('P3: 通知收敛到共享实现，且默认只在页面不可见时发', () => {
    const n = read('lib/browser-notify.ts')
    expect(n).toContain('export function notify')
    expect(n).toContain('requestNotifyPermission')
    expect(n).toMatch(/document\.hidden/)
    expect(n).toMatch(/force/)
  })

  it('P3: 三处都收敛到共享通知（不再各写一份）', () => {
    for (const f of ['app/(app)/canvas/page.tsx', 'components/canvas/CopilotPanel.tsx', 'components/tools/ToolAgentPanel.tsx']) {
      expect(read(f), f).toMatch(/^import .*browser-notify/m)
    }
  })

  it('P3: Agent 在用户手势（发送）里请求通知权限', () => {
    const panel = read('components/tools/ToolAgentPanel.tsx')
    expect(panel).toContain('requestNotifyPermission()')
  })

  it('P4: maintenance 收敛僵死 RUNNING（画布 + Agent 任务都要）', () => {
    const m = read('lib/maintenance.ts')
    expect(m).toContain('staleRuns')
    expect(m).toMatch(/canvasRun\.updateMany/)
    expect(m).toMatch(/generationTask\.updateMany/)
    // Q-D46 后 RUNNING 走 CANVAS_RUN_STATUS.RUNNING / GENERATION_TASK_STATUS.RUNNING 常量
    expect(m).toMatch(/status: (CANVAS_RUN_STATUS|GENERATION_TASK_STATUS)\.RUNNING|status: 'RUNNING'/)
  })

  it('P4: 收敛必须排在预扣对账之前（否则僵死 RUNNING 的预扣永远退不回）', () => {
    const m = read('lib/maintenance.ts')
    const converge = m.indexOf('staleRuns =')
    const reconcile = m.indexOf('staleHolds = await')
    expect(converge).toBeGreaterThan(0)
    expect(reconcile).toBeGreaterThan(0)
    expect(converge).toBeLessThan(reconcile)
  })
})
