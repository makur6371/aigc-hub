import { getPrisma } from './prisma'

/**
 * 从 DB 读「用户可见的节点目录」—— 权威来源。
 *
 * 背景（2026-10-16「节点库每个都是两份」根修的第二阶段）：
 * 内置节点的权威定义在源码 `BUILTIN_NODES`，但**生效的是 DB**：
 *   - `executeCustomNode` 只查 DB 的 codeSchema
 *   - `nodeInfoMap` 以 DB 段覆盖源码段
 * 启动时 `syncBuiltinNodes()` 已把源码 upsert 进库（见 `lib/prisma.ts`），
 * 所以 DB 与源码一致；这里统一从 DB 读，让 Copilot / MCP / 节点文档
 * 与「用户真正能在节点库选到的节点」严格对齐 —— 包括禁用状态与自定义节点。
 *
 * 与 `/api/canvas-nodes` 的差别：那个接口按登录用户过滤（官方 + 自己创建的），
 * 这里面向「AI 帮用户搭工作流」的场景，只看官方节点（isOfficial=true 且未禁用），
 * 不把别人的私有自定义节点泄露给 Copilot。
 */

export type CatalogNode = {
  nodeType: string
  label: string
  category: string
  description: string
  inputs: Record<string, { type: string; label: string; required?: boolean }>
  outputs: Record<string, { type: string; label: string }>
}

/**
 * 读官方节点目录（未禁用的）。
 *
 * 失败时返回空数组而不是抛错：Copilot / MCP 的调用方都是「尽力而为」的
 * 增强上下文，目录拉不到不该让整个请求失败（最坏情况是 AI 看不到节点表，
 * 由调用方已有的兜底话术处理）。
 */
export async function getOfficialNodeCatalog(): Promise<CatalogNode[]> {
  try {
    const prisma = await getPrisma()
    const rows = await prisma.canvasNodeSpec.findMany({
      where: { isOfficial: true, isDisabled: false },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((n) => ({
      nodeType: n.nodeType,
      label: n.label,
      category: (n.category as string) || 'custom',
      description: (n.description as string) || '',
      inputs: (n.inputs as Record<string, CatalogNode['inputs'][string]>) || {},
      outputs: (n.outputs as Record<string, CatalogNode['outputs'][string]>) || {},
    }))
  } catch (err) {
    console.error('[node-catalog] 读取节点目录失败:', err)
    return []
  }
}

/** 分类中文名（与 /api/canvas-nodes 保持一致） */
export const NODE_CATEGORY_LABELS: Record<string, string> = {
  llm: 'LLM 处理',
  image: '图像生成',
  video: '视频处理',
  audio: '音频生成',
  logic: '逻辑控制',
  data: '数据转换',
  io: '输入输出',
  custom: '自定义节点',
}
