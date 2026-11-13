import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { clearAgentConfigCache, getAgentConfig, parseBackupIds } from '@/lib/agent-config'

// GET /api/admin/agent-config - 读取 Agent 全局配置
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  return success(await getAgentConfig())
})

// PUT /api/admin/agent-config - 保存 Agent 全局配置
export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json() as { planningModelId?: string | null; planningBackupModelIds?: unknown }

  const planningModelId = typeof body.planningModelId === 'string' && body.planningModelId ? body.planningModelId : null
  // 替补链：有序 id 数组。去重、剔除与主模型重复项、逐个校验必须是启用中的 TEXT/VISION。
  const backupIds = parseBackupIds(body.planningBackupModelIds).filter((id) => id !== planningModelId)

  const prisma = await getPrisma()
  if (planningModelId) {
    const model = await prisma.modelConfig.findUnique({ where: { id: planningModelId }, select: { id: true, type: true } })
    if (!model) {
      throw new ApiHandlerError('所选模型不存在', 400)
    }
    if (model.type !== 'TEXT' && model.type !== 'VISION') {
      throw new ApiHandlerError('规划模型必须是启用的 TEXT / VISION 类型', 400)
    }
  }
  if (backupIds.length > 0) {
    const found = await prisma.modelConfig.findMany({
      where: { id: { in: backupIds } },
      select: { id: true, type: true },
    })
    const byId = new Map(found.map((m) => [m.id, m.type]))
    for (const id of backupIds) {
      const type = byId.get(id)
      if (!type) throw new ApiHandlerError('替补模型不存在', 400)
      if (type !== 'TEXT' && type !== 'VISION') throw new ApiHandlerError('替补模型必须是启用的 TEXT / VISION 类型', 400)
    }
  }

  await prisma.agentConfig.upsert({
    where: { id: 'primary' },
    update: { planningModelId, planningBackupModelIds: backupIds },
    create: { id: 'primary', planningModelId, planningBackupModelIds: backupIds },
  })

  clearAgentConfigCache()
  return success(await getAgentConfig(), '已保存')
})
