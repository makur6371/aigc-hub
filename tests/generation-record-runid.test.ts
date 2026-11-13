import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

/**
 * Q-D09① 的回归守卫：**每一处生成记录落库都必须带上计费事务号 runId**。
 *
 * 为什么钉这条：`chargeRun` 兜底生成事务号之后，「流水 ↔ 调用日志 ↔ 生成记录」三方
 * 能不能对平，取决于记录侧有没有把号写下来。漏一个点不会报错、不会失败，
 * 只会让那类记录在审计与「任务」列里永远查不到来源 —— 正是当初查不出孤儿扣费的原因。
 */

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) tsFiles(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('生成记录必须携带 runId（Q-D09①）', () => {
  const files = [...tsFiles('src/app/api'), ...tsFiles('src/lib')]

  it('所有 GenerationRecord.create 调用点都写了 runId', () => {
    const offenders: string[] = []
    let seen = 0
    for (const f of files) {
      const src = readSource(f)
      let i = 0
      while (true) {
        const at = src.indexOf('GenerationRecord.create(', i)
        if (at < 0) break
        seen++
        // 取该 create 之后的一段（到下一个 create 或 60 行内），看是否写了 runId
        const next = src.indexOf('GenerationRecord.create(', at + 1)
        const body = src.slice(at, next < 0 ? at + 1400 : next)
        if (!/\brunId\s*:/.test(body)) offenders.push(`${f} @ create#${seen}`)
        i = at + 1
      }
    }
    // 先确认确实扫到了这些调用点（否则本测试会因扫描失效而假绿）
    expect(seen).toBeGreaterThanOrEqual(11)
    expect(offenders, `这些生成记录没写 runId：\n${offenders.join('\n')}`).toEqual([])
  })
})
