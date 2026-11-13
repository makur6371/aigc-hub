import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Agent 规划候选链的组装规则（源码级守卫）。
 *
 * 为什么用源码断言而不是跑函数：planningCandidates 依赖 Prisma + DB，
 * 单测里跑要起库。这条规则的核心是一个 if/else 分支，用源码断言足够锁住，
 * 且能精确表达「不许再无条件追加默认池」这个曾经踩过两次的坑。
 *
 * 历史：
 *   ① 只返回 [pinned] → 候选断崖，钉到慢模型就整条失败
 *   ② pinned + 替补 + 其余全部模型 → 管理员只配 1~2 个却会试遍全库
 *   现在：配置即白名单；零配置才回默认池
 */

const src = readFileSync(resolve(__dirname, '../src/lib/agent-config.ts'), 'utf8')

describe('planningCandidates — 配置即白名单', () => {
  it('存在 configured 分支判断', () => {
    expect(src).toContain('const configured = Boolean(pinnedId) || backupIds.length > 0')
  })

  it('配置过 → 只 push 主模型与替补链，绝不追加默认池', () => {
    const start = src.indexOf('if (configured) {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('} else {', start)
    expect(end).toBeGreaterThan(start)
    const branch = src.slice(start, end)
    expect(branch).toContain('push(pool.find((model) => model.id === pinnedId))')
    expect(branch).toContain('for (const id of backupIds)')
    expect(branch).not.toContain('for (const model of pool) push(model)')
  })

  it('未配置 → 默认池是唯一入口（保证零配置可用）', () => {
    const elseAt = src.indexOf('} else {', src.indexOf('if (configured) {'))
    expect(elseAt).toBeGreaterThan(-1)
    const end = src.indexOf('return ordered', elseAt)
    const branch = src.slice(elseAt, end)
    expect(branch).toContain('for (const model of pool) push(model)')
  })

  it('函数整体不再无条件追加默认池（防止旧写法回归）', () => {
    const fnStart = src.indexOf('export async function planningCandidates()')
    const fnEnd = src.indexOf('return ordered', fnStart)
    const fn = src.slice(fnStart, fnEnd)
    const occurrences = fn.split('for (const model of pool) push(model)').length - 1
    expect(occurrences).toBe(1)
  })
})
