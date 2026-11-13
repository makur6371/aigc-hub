import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSource } from './helpers/source-guard'

/**
 * 分页列表必须有**唯一 tiebreaker**（Q-A04）。
 *
 * ===== 问题（不是风格问题，是排序不确定）=====
 * 后台有 11 个分页列表用 `orderBy: { createdAt: 'desc' }`（或 `status + createdAt`）分页。
 * 这些排序键**都不是唯一的** —— SQL 标准对「排序键相同的行之间」**不保证顺序**。
 * 而生产库里确实存在大撞车组（实测：`prompt_templates` 有 3 组，分别 **120 / 118 / 110 行**
 * 共用同一个 `createdAt`，是种子导入的产物；`shared_works` 有 24 组撞车）。
 *
 * 当一个 20 行的分页边界正好落在 120 行的撞车组内部时，
 * 两次请求若返回不同的组内顺序，就会**同一行出现两次、另一行永远看不到**
 * —— 后台管理员看到的是「列表里少了一条记录」，且**刷新一下就变**，极难排查。
 *
 * ===== 诚实说明：我没能复现「真的漏行」=====
 * 在本地与生产库上跑了对照实验（同一 SQL 连跑两次、换查询计划），
 * **当前 SQLite 的组内顺序恰好稳定**（rowid 序）。所以这条不是「已复现的线上 bug」，
 * 而是**未定义行为 + 已知存在的大撞车组** —— 一旦查询计划变化（加索引、改谓词、
 * 数据更新导致 status 变化）就可能翻车。加 `id` 作为 tiebreaker 的成本是零，
 * 收益是「排序从此有定义」，所以直接修，而不是等它真的发生。
 *
 * ===== 为什么不是「统一排序口径」=====
 * 台账原来记的是「6 种排序口径不一致」。逐条核过：那些差异**多数是有意的** ——
 *   - `isActive desc` / `status asc`：都是「待处理的排前面」，字段名不同而已；
 *   - `sortOrder asc`（充值档位）：运营手排顺序；
 *   - `builtIn desc + createdAt asc`（提示词源）：内置在前、老的在前；
 *   - `type + name asc`（免费额度 / 模型性能）：分组浏览要字母序；
 *   - `submittedAt asc`（问卷提交记录）：按答题时间正序看流程。
 * **强行统一成一种口径会破坏这些业务语义**。真正缺的是「分页要稳定」，所以只补 tiebreaker。
 */

const ADMIN_DIR = 'src/app/api/admin'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
    else if (name === 'route.ts') out.push(rel)
  }
  return out
}

describe('后台分页列表的排序必须确定', () => {
  const routes = walk(ADMIN_DIR)

  it('扫描范围自检', () => {
    expect(routes.length).toBeGreaterThan(40)
  })

  it('凡是分页（有 skip）的查询，orderBy 必须包含唯一键（id）', () => {
    const offenders: string[] = []
    for (const f of routes) {
      const src = readSource(f)
      if (!/skip:/.test(src)) continue
      const orderLines = src.split('\n').filter((l) => /orderBy:/.test(l))
      if (!orderLines.length) continue
      if (!orderLines.some((l) => /\bid:/.test(l))) offenders.push(f)
    }
    expect(
      offenders,
      `这些分页查询的 orderBy 没有唯一 tiebreaker —— 排序键撞车时行序不确定，翻页会漏行/重行：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('tiebreaker 的方向要与主键一致（都用 desc，避免「看起来乱了」）', () => {
    // 抽查几个典型：createdAt desc 的列表，id 也应是 desc
    for (const f of ['src/app/api/admin/users/route.ts', 'src/app/api/admin/usage-logs/route.ts']) {
      const src = readSource(f)
      expect(src).toMatch(/orderBy: \[\{ createdAt: 'desc' \}, \{ id: 'desc' \}\]/)
    }
  })
})
