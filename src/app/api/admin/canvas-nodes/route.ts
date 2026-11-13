import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'
import { BUILTIN_NODES } from '@/lib/canvas-nodes'

export const GET = apiHandler(async () => {
  const prisma = await getPrisma()
  const dbNodes = await prisma.canvasNodeSpec.findMany({
    orderBy: { createdAt: 'desc' },
  })

  // 内置节点禁用状态映射：从 DB 读内置 nodeType 的 isDisabled（未落库默认启用）
  const disabledBuiltinTypes = new Set(
    dbNodes.filter((n) => n.isDisabled).map((n) => n.nodeType)
  )

  const builtins = (disputed: typeof disabledBuiltinTypes) =>
    BUILTIN_NODES.map((n) => ({
      id: `builtin-${n.type}`,
      nodeType: n.type,
      label: n.label,
      category: n.category,
      description: n.description,
      codeSchema: n.codeSchema,
      isOfficial: true,
      isBuiltin: true,
      isDisabled: disputed.has(n.type),
      creatorId: null,
      createdAt: null,
      updatedAt: null,
    }))

  const custom = dbNodes.map((n) => ({
    id: n.id,
    nodeType: n.nodeType,
    label: n.label,
    category: (n.category as string) || 'custom',
    description: (n.description as string) || '',
    inputs: (n.inputs as Record<string, unknown>) || {},
    outputs: (n.outputs as Record<string, unknown>) || {},
    codeSchema: n.codeSchema,
    isOfficial: n.isOfficial,
    isBuiltin: false,
    isDisabled: n.isDisabled,
    creatorId: n.creatorId,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  }))

  return [...builtins(disabledBuiltinTypes), ...custom]
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request, { admin: true })
  const { nodeType, label, codeSchema, isOfficial, inputs, outputs, description, category } = await request.json()

  if (!nodeType || !label || !codeSchema) {
    throw new Error('请填写完整')
  }

  const prisma = await getPrisma()
  const existing = await prisma.canvasNodeSpec.findFirst({ where: { nodeType } })
  if (existing || BUILTIN_NODES.some((n) => n.type === nodeType)) {
    throw new Error('节点类型标识已存在')
  }

  const node = await prisma.canvasNodeSpec.create({
    data: {
      nodeType,
      label,
      codeSchema: typeof codeSchema === 'string' ? codeSchema : JSON.stringify(codeSchema),
      isOfficial: isOfficial ?? true,
      creatorId: authUser.userId,
      inputs: inputs && typeof inputs === 'object' ? inputs : {},
      outputs: outputs && typeof outputs === 'object' ? outputs : {},
      description: description || '',
      category: category || 'custom',
    },
  })

  return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() }
})
