import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'

export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  const workflows = await prisma.canvasWorkflow.findMany({
    where: { userId: authUser.userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return workflows.map((w) => ({
    ...w,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }))
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const { name, nodes, connections } = await request.json()
  if (!name || !Array.isArray(nodes) || !Array.isArray(connections)) {
    throw new ApiHandlerError('参数不完整', 400)
  }

  const prisma = await getPrisma()
  const workflow = await prisma.canvasWorkflow.create({
    data: {
      name: String(name),
      nodes: nodes as object,
      connections: connections as object,
      userId: authUser.userId,
    },
  })

  return {
    ...workflow,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  }
})
