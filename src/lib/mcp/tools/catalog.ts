// 目录工具：节点类型目录 + 模型清单（Agent 搭工作流前先读这两份）。
// 均为只读、数据小，直接返回。

import { getPrisma } from '@/lib/prisma'
import { getOfficialNodeCatalog } from '@/lib/node-catalog'
import type { ToolResult } from './types'

/**
 * 节点类型目录。
 *
 * 2026-10-16 起从 DB 读（`getOfficialNodeCatalog`）而不是源码 BUILTIN_NODES：
 * 内置节点的生效定义在 DB（`executeCustomNode` 只查 DB 的 codeSchema），
 * 启动时会把源码 upsert 进库。读 DB 才能让 MCP 客户端看到与用户节点库
 * 完全一致的节点 —— 包括被管理员禁用的节点（不再出现）。
 */
export async function listNodeTypes(): Promise<ToolResult> {
  const nodes = await getOfficialNodeCatalog()
  const structured = {
    count: nodes.length,
    nodes: nodes.map((n) => ({
      type: n.nodeType,
      label: n.label,
      category: n.category,
      description: n.description,
      inputs: n.inputs,
      outputs: n.outputs,
    })),
  }
  return {
    content: [{
      type: 'text',
      text: `共 ${nodes.length} 种节点类型。搭建工作流前先看清楚每个节点的 inputs/outputs 端口类型，连线必须类型兼容。写工作流时节点结构：{id, type, label, category, x, y, inputs:{...端口对应参数}, outputs:{}}`,
    }],
    structuredContent: structured,
  }
}

export async function listModels(args: { type?: string }): Promise<ToolResult> {
  const prisma = await getPrisma()
  const where: Record<string, unknown> = { isActive: true, provider: { isActive: true } }
  if (args.type && ['TEXT', 'VISION', 'IMAGE', 'VIDEO', 'AUDIO'].includes(args.type)) {
    where.type = args.type
  }
  const models = await prisma.modelConfig.findMany({
    where,
    select: {
      id: true,
      name: true,
      type: true,
      costPoints: true,
      discount: true,
      isFree: true,
      videoCost: true,
    },
    orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
  })
  const { effectivePoints } = await import('@/lib/pricing')
  const structured = {
    count: models.length,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      pointsPerCall: effectivePoints(m.costPoints, m.discount, m.isFree),
      isFree: m.isFree,
    })),
  }
  return {
    content: [{
      type: 'text',
      text: `共 ${models.length} 个可用模型。llm-chat / image-generate / video-generate 节点的 inputs.model 填这里返回的 id（不填则自动选该类型第一个模型）`,
    }],
    structuredContent: structured,
  }
}
