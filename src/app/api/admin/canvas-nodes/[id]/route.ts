import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { BUILTIN_NODES } from '@/lib/canvas-nodes'
import type { Prisma } from '@prisma/client'

// PATCH：仅允许切换节点禁用状态。内置节点只写 isDisabled（codeSchema/label 等仍禁改）
export const PATCH = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    if (typeof body.isDisabled !== 'boolean') {
      throw new ApiHandlerError('isDisabled 必须是布尔值', 400)
    }

    const prisma = await getPrisma()

    // 内置节点：以内置 nodeType 的记录（或新建）落库 isDisabled
    if (id.startsWith('builtin-')) {
      const nodeType = id.slice('builtin-'.length)
      if (!BUILTIN_NODES.some((n) => n.type === nodeType)) {
        throw new ApiHandlerError('未知内置节点', 400)
      }
      const node = await prisma.canvasNodeSpec.findFirst({ where: { nodeType } })
      if (node) {
        await prisma.canvasNodeSpec.update({
          where: { id: node.id },
          data: { isDisabled: body.isDisabled },
        })
      } else {
        const def = BUILTIN_NODES.find((n) => n.type === nodeType)!
        await prisma.canvasNodeSpec.create({
          data: {
            nodeType,
            label: def.label,
            category: def.category,
            description: def.description,
            inputs: def.inputs as unknown as Prisma.InputJsonValue,
            outputs: def.outputs as unknown as Prisma.InputJsonValue,
            codeSchema: def.codeSchema,
            isOfficial: true,
            isDisabled: body.isDisabled,
          },
        })
      }
      return success(null, body.isDisabled ? '已禁用' : '已启用')
    }

    // 自定义节点：直接更新记录的 isDisabled
    const node = await prisma.canvasNodeSpec.update({
      where: { id },
      data: { isDisabled: body.isDisabled },
    })

    return success(
      { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() },
      body.isDisabled ? '已禁用' : '已启用'
    )
  }
)

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    if (id.startsWith('builtin-')) {
      throw new ApiHandlerError('内置节点不可编辑', 400)
    }

    const body = await request.json()
    const prisma = await getPrisma()

    const node = await prisma.canvasNodeSpec.update({
      where: { id },
      data: {
        label: body.label,
        codeSchema: typeof body.codeSchema === 'string' ? body.codeSchema : JSON.stringify(body.codeSchema),
        isOfficial: body.isOfficial,
        inputs: body.inputs && typeof body.inputs === 'object' ? body.inputs : {},
        outputs: body.outputs && typeof body.outputs === 'object' ? body.outputs : {},
        description: body.description || '',
        category: body.category || 'custom',
      },
    })

    return success(
      { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() },
      '更新成功'
    )
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    if (id.startsWith('builtin-')) {
      throw new ApiHandlerError('内置节点不可删除', 400)
    }

    const prisma = await getPrisma()
    await prisma.canvasNodeSpec.delete({ where: { id } })

    return success(null, '删除成功')
  }
)
