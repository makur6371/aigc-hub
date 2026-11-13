import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { BUILTIN_NODES } from '@/lib/canvas-nodes'
import { NODE_CATEGORY_LABELS } from '@/lib/node-catalog'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const GET = apiHandler(async (request: NextRequest, { url }) => {
  const authUser = await getAuthUser(request)
  const prisma = await getPrisma()

  const category = url.searchParams.get('category')

  const where: Record<string, unknown> = { isOfficial: true }
  if (authUser) {
    where.OR = [
      { isOfficial: true },
      { creatorId: authUser.userId },
    ]
  }

  const dbNodes = await prisma.canvasNodeSpec.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  // 同一个 nodeType 有两个来源：BUILTIN_NODES（源码）与 canvas_node_specs（DB）。
  // DB 是权威（禁用状态/官方标记/自定义节点都在 DB，且 executeCustomNode 只查 DB），
  // 所以这里以 DB 为准，BUILTIN_NODES 只补 DB 里没有的 nodeType
  // —— 老库漏播种时（如 face-doodle 长期未落库）节点仍然出得来，不会静默消失。
  const dbTypes = new Set(dbNodes.map((n) => n.nodeType))
  const builtinFallback = BUILTIN_NODES.filter((n) => !dbTypes.has(n.type))

  // 内置节点禁用状态映射：DB 里该 nodeType 的记录 isDisabled=true 即视为禁用。
  // 未落库的内置节点（源码里有、DB 里没有）不进这个集合，即默认启用。
  const disabledBuiltinTypes = new Set(
    dbNodes.filter((n) => n.isDisabled).map((n) => n.nodeType)
  )

  let allNodes = [
    ...dbNodes
      .filter((n) => !n.isDisabled)
      .map((n) => ({
        id: n.id,
        nodeType: n.nodeType,
        label: n.label,
        codeSchema: n.codeSchema,
        isOfficial: n.isOfficial,
        category: (n.category as string) || 'custom',
        categoryLabel: NODE_CATEGORY_LABELS[(n.category as string) || 'custom'] || '自定义节点',
        inputs: (n.inputs as Record<string, unknown>) || {},
        outputs: (n.outputs as Record<string, unknown>) || {},
        description: (n.description as string) || '',
        creatorId: n.creatorId,
      })),
    ...builtinFallback.filter((n) => !disabledBuiltinTypes.has(n.type)).map((n) => ({
      id: `builtin-${n.type}`,
      nodeType: n.type,
      label: n.label,
      codeSchema: n.codeSchema,
      isOfficial: true,
      category: n.category,
      categoryLabel: NODE_CATEGORY_LABELS[n.category] || n.category,
      inputs: n.inputs,
      outputs: n.outputs,
      description: n.description,
    })),
  ]

  if (category) {
    allNodes = allNodes.filter((n) => n.category === category)
  }

  return allNodes
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const { nodeType, label, codeSchema, isOfficial, inputs, outputs, description, category } = await request.json()
  if (!nodeType || !label || !codeSchema) {
    throw new ApiHandlerError('请填写完整', 400)
  }

  const createOfficial = isOfficial && authUser.role === 'ADMIN'

  const prisma = await getPrisma()
  const node = await prisma.canvasNodeSpec.create({
    data: {
      nodeType,
      label,
      codeSchema: typeof codeSchema === 'string' ? codeSchema : JSON.stringify(codeSchema),
      isOfficial: createOfficial,
      creatorId: authUser.userId,
      inputs: inputs && typeof inputs === 'object' ? inputs : {},
      outputs: outputs && typeof outputs === 'object' ? outputs : {},
      description: description || '',
      category: category || 'custom',
    },
  })

  return success(
    { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() },
    '创建成功'
  )
})
