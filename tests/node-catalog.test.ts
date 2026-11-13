import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 节点目录单一来源（DB）—— 2026-10-16「节点库每个都是两份」根修的第二阶段
 *
 * 第一阶段修了用户可见的节点库（`/api/canvas-nodes` 去重 + 启动同步）。
 * 剩下两处仍直接读源码 `BUILTIN_NODES`，导致「用户禁用了某个节点，Copilot/MCP
 * 照样往里搭」—— 用户选不到，AI 却生成了，跑起来才报错。
 *
 * 这两处现在统一走 `getOfficialNodeCatalog()`（读 DB），本文件锁死：
 *   1) 只出官方节点（别人的私有自定义节点不能泄露给 Copilot）
 *   2) 禁用的节点不出（isDisabled 真正对 AI 生效）
 *   3) DB 拉挂时返回空数组而不是抛错（目录是尽力而为的增强上下文）
 *   4) MCP 的 list_node_types 与用户节点库口径一致
 */

const mockFindMany = vi.fn<(arg: unknown) => Promise<unknown[]>>(async () => [])

vi.mock('@/lib/prisma', () => ({ getPrisma: async () => ({ canvasNodeSpec: { findMany: mockFindMany } }) }))

type FindManyArg = { where: Record<string, unknown> }

beforeEach(() => { mockFindMany.mockReset() })

const row = (over: Record<string, unknown> = {}) => ({
  nodeType: 'llm-chat',
  label: 'LLM 对话',
  category: 'llm',
  description: '调用大语言模型',
  inputs: { prompt: { type: 'string', label: '提示词', required: true } },
  outputs: { text: { type: 'string', label: '生成文本' } },
  ...over,
})

describe('getOfficialNodeCatalog —— 读 DB，只给 AI 看用户选得到的节点', () => {
  it('查询条件限定 isOfficial + 未禁用（两个条件缺一不可）', async () => {
    mockFindMany.mockImplementation(async () => [])
    const { getOfficialNodeCatalog } = await import('@/lib/node-catalog')
    await getOfficialNodeCatalog()
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const arg = mockFindMany.mock.calls[0]?.[0] as unknown as FindManyArg | undefined
    expect(arg?.where).toMatchObject({ isOfficial: true, isDisabled: false })
  })

  it('把 DB 行映射成 nodeType 形状（不是 type）', async () => {
    mockFindMany.mockImplementation(async () => [row()])
    const { getOfficialNodeCatalog } = await import('@/lib/node-catalog')
    const nodes = await getOfficialNodeCatalog()
    expect(nodes).toHaveLength(1)
    expect(nodes[0].nodeType).toBe('llm-chat')
    expect(nodes[0].inputs.prompt).toMatchObject({ type: 'string', required: true })
  })

  it('category 为空时兜底为 custom（DB 该列有默认值，但老数据不保证）', async () => {
    mockFindMany.mockImplementation(async () => [row({ category: null })])
    const { getOfficialNodeCatalog } = await import('@/lib/node-catalog')
    const nodes = await getOfficialNodeCatalog()
    expect(nodes[0].category).toBe('custom')
  })

  it('inputs/outputs 为 null 时兜底为空对象，不抛错', async () => {
    mockFindMany.mockImplementation(async () => [row({ inputs: null, outputs: null })])
    const { getOfficialNodeCatalog } = await import('@/lib/node-catalog')
    const nodes = await getOfficialNodeCatalog()
    expect(nodes[0].inputs).toEqual({})
    expect(nodes[0].outputs).toEqual({})
  })

  it('DB 查询失败返回空数组（目录是尽力而为，不能拖垮 Copilot/MCP）', async () => {
    mockFindMany.mockImplementation(async () => { throw new Error('db down') })
    const { getOfficialNodeCatalog } = await import('@/lib/node-catalog')
    await expect(getOfficialNodeCatalog()).resolves.toEqual([])
  })
})

describe('MCP list_node_types —— 与用户节点库同源', () => {
  it('返回 DB 里的节点，count 与实际条数一致', async () => {
    mockFindMany.mockImplementation(async () => [
      row(),
      row({ nodeType: 'image-generate', label: '图像生成', category: 'image' }),
    ])
    const { listNodeTypes } = await import('@/lib/mcp/tools/catalog')
    const res = await listNodeTypes()
    const structured = res.structuredContent as { count: number; nodes: { type: string }[] }
    expect(structured.count).toBe(2)
    expect(structured.nodes.map((n) => n.type)).toEqual(['llm-chat', 'image-generate'])
    // 文本里也要带真实条数，否则 AI 读到「共 28 种」却只有 2 个 structured 项
    expect(res.content[0].text).toContain('共 2 种节点类型')
  })

  it('不再直接读源码 BUILTIN_NODES（禁用的节点必须对 MCP 也生效）', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, '..', 'src/lib/mcp/tools/catalog.ts'), 'utf8')
    // 注释里会提到 BUILTIN_NODES（说明为什么改），所以只查真实引用：
    // import 语句与标识符用法。
    expect(src).not.toMatch(/^import .*BUILTIN_NODES/m)
    expect(src).not.toMatch(/\bBUILTIN_NODES\.(length|map|filter)/)
    expect(src).toContain('getOfficialNodeCatalog')
  })
})

describe('Copilot 节点目录 —— 同源 + 动态端口仍保留', () => {
  it('从 DB 读目录，且不再单独查一次禁用表', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, '..', 'src/app/api/canvas/copilot/route.ts'), 'utf8')
    expect(src).toContain('getOfficialNodeCatalog')
    expect(src).not.toContain('disabledBuiltinTypes')
    // 动态端口（视觉模型的 image 口）是 Copilot 特有的，不能因换数据源丢掉
    expect(src).toContain('参考图片(需视觉模型)')
  })
})
