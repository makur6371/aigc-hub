import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 节点库「每个节点两份」回归守卫
 *
 * 事故形状（2026-10-16 用户报「节点库为啥每个都是两份」）：
 *   GET /api/canvas-nodes 把两个来源**无脑拼接**返回：
 *     1) BUILTIN_NODES（源码 src/lib/canvas-nodes.ts）
 *     2) canvas_node_specs（DB，「同步内置节点」按钮播种过）
 *   sync-builtin 让两者逐字段完全相同，于是每个 nodeType 命中两条
 *   （id 分别是 builtin-<type> 与 cuid）→ 节点库每个分类都渲染两份。
 *
 * 为什么必须钉死：这是**展示层重复 + 权威性分裂**的混合 bug。
 *   - DB 段在后，nodeInfoMap 按 nodeType 覆盖 → 实际生效的是 DB 那份
 *   - executeCustomNode 只查 DB 的 codeSchema → 改源码不改 DB = 线上零变化
 *   只改显示会留下「改了源码不生效」的静默坑，所以这里同时锁两件事：
 *   去重存在 + 源码改动能真正到达 DB。
 */

const SRC = join(__dirname, '..', 'src')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n')

const nodesRoute = read('app/api/canvas-nodes/route.ts')
const syncRoute = read('app/api/admin/canvas-nodes/sync-builtin/route.ts')
const prismaLib = read('lib/prisma.ts')

describe('节点库去重 —— DB 权威，源码只补缺', () => {
  it('先算 DB 已有的 nodeType 集合，再决定 BUILTIN_NODES 补哪些', () => {
    expect(nodesRoute).toMatch(/const dbTypes = new Set\(dbNodes\.map\(\(n\) => n\.nodeType\)\)/)
    expect(nodesRoute).toMatch(/const builtinFallback = BUILTIN_NODES\.filter\(\(n\) => !dbTypes\.has\(n\.type\)\)/)
  })

  it('DB 段排在 builtinFallback 之前（后者只补 DB 没有的 nodeType）', () => {
    const dbIdx = nodesRoute.indexOf('...dbNodes')
    const fbIdx = nodesRoute.indexOf('...builtinFallback')
    expect(dbIdx).toBeGreaterThan(0)
    expect(fbIdx).toBeGreaterThan(0)
    expect(dbIdx).toBeLessThan(fbIdx)
  })

  it('不再直接展开整个 BUILTIN_NODES（那是重复渲染的根因）', () => {
    expect(nodesRoute).not.toMatch(/\.\.\.BUILTIN_NODES\.(filter|map)\(/)
  })

  it('DB 段仍按 isDisabled 过滤（禁用语义不得回归）', () => {
    expect(nodesRoute).toMatch(/\.\.\.dbNodes\s*\n\s*\.filter\(\(n\) => !n\.isDisabled\)/)
  })

  it('未落库的内置节点仍可用禁用集合兜底（DB 缺记录时不至于禁不掉）', () => {
    expect(nodesRoute).toMatch(/builtinFallback\.filter\(\(n\) => !disabledBuiltinTypes\.has\(n\.type\)\)/)
  })
})

describe('源码定义必须能到达 DB（否则改源码 = 线上零变化）', () => {
  it('存在可复用的 syncBuiltinNodes 实现', () => {
    const sync = read('lib/sync-builtin-nodes.ts')
    expect(sync).toContain('export async function syncBuiltinNodes')
    // 只 upsert 不删除：DB 里可能有用户自建记录，绝不能因同步被清掉
    expect(sync).toContain('findFirst')
    expect(sync).not.toMatch(/canvasNodeSpec\.delete/)
  })

  it('启动时自动同步一次（对齐 Dockerfile 的 prisma db push 语义）', () => {
    expect(prismaLib).toMatch(/import\('\.\/sync-builtin-nodes'\)/)
    expect(prismaLib).toMatch(/m\.syncBuiltinNodes\(\)/)
  })

  it('admin 按钮与启动同步同一实现，不另写一份 upsert 循环', () => {
    expect(syncRoute).toContain("from '@/lib/sync-builtin-nodes'")
    expect(syncRoute).toMatch(/await syncBuiltinNodes\(\)/)
    // 老实现是手写 for + findFirst/update/create，现在不该再出现
    expect(syncRoute).not.toMatch(/for \(const node of BUILTIN_NODES\)/)
    expect(syncRoute).not.toMatch(/prisma\.canvasNodeSpec\.create/)
  })

  it('同步绝不触碰 isDisabled（否则一次部署就把运维禁用的节点放出来）', () => {
    const sync = read('lib/sync-builtin-nodes.ts')
    const upsertBlocks = sync.match(/data: \{[\s\S]*?\}/g) || []
    expect(upsertBlocks.length).toBeGreaterThan(0)
    for (const block of upsertBlocks) {
      expect(block).not.toContain('isDisabled')
    }
  })
})
