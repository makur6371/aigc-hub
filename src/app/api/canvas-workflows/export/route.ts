import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'

/**
 * 导出工作流为 JSON 文件
 * GET /api/canvas-workflows/export?id=xxx
 */
export const GET = apiHandler<{ id?: string }>(async (request: NextRequest, { url }) => {
  const authUser = await requireAuth(request)

  const id = url.searchParams.get('id')
  if (!id) {
    throw new ApiHandlerError('缺少工作流 ID', 400)
  }

  const prisma = await getPrisma()
  const workflow = await prisma.canvasWorkflow.findFirst({
    where: { id, userId: authUser.userId },
  })
  if (!workflow) {
    throw new ApiHandlerError('工作流不存在', 404)
  }

  const exportData = {
    version: '1.0',
    type: 'aigc-hub-workflow',
    exportedAt: new Date().toISOString(),
    workflow: {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
    },
  }

  const filename = `${workflow.name.replace(/[^a-zA-Z0-9一-龥]/g, '_')}.json`

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})
