import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const GET = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const workflow = await prisma.canvasWorkflow.findUnique({ where: { id } })
    if (!workflow || workflow.userId !== authUser.userId) {
      throw new ApiHandlerError('工作流不存在', 404)
    }

    return {
      ...workflow,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    }
  }
)

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params

    const { name, nodes, connections } = await request.json()
    if (!name || !Array.isArray(nodes) || !Array.isArray(connections)) {
      throw new ApiHandlerError('参数不完整', 400)
    }

    const prisma = await getPrisma()
    const existing = await prisma.canvasWorkflow.findUnique({ where: { id } })
    if (!existing || existing.userId !== authUser.userId) {
      throw new ApiHandlerError('工作流不存在', 404)
    }

    const workflow = await prisma.canvasWorkflow.update({
      where: { id },
      data: {
        name: String(name),
        nodes: nodes as object,
        connections: connections as object,
      },
    })

    return {
      ...workflow,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    }
  }
)

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const existing = await prisma.canvasWorkflow.findUnique({ where: { id } })
    if (!existing || existing.userId !== authUser.userId) {
      throw new ApiHandlerError('工作流不存在', 404)
    }

    await prisma.canvasWorkflow.delete({ where: { id } })
    return success(null, '删除成功')
  }
)
