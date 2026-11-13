import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth } from '@/lib/api-handler'

type ProviderRow = Awaited<ReturnType<typeof import('@prisma/client').PrismaClient.prototype.apiProvider.findFirstOrThrow>> & {
  _count?: { models: number }
}

const serializeProvider = (p: ProviderRow) => ({
  id: p.id,
  name: p.name,
  code: p.code,
  baseUrl: p.baseUrl,
  apiKey: p.apiKey ? '****' + p.apiKey.slice(-4) : null,
  configSchema: p.configSchema,
  adapterId: p.adapterId,
  configJson: p.configJson,
  isActive: p.isActive,
  modelCount: p._count?.models ?? 0,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
})

export const GET = apiHandler(async () => {
  const prisma = await getPrisma()
  const providers = await prisma.apiProvider.findMany({
    // 启用的排在前面：管理员最常看的是「当前在用的供应商」，
    // 停用的沉到下面而不是混在时间线里（与 models/tools/works 的排序口径一致）。
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    include: { _count: { select: { models: true } } },
  })
  return providers.map(serializeProvider)
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const { name, code, baseUrl, apiKey, configSchema, adapterId, configJson, isActive } = await request.json()
  if (!name || !code || !baseUrl) {
    throw new Error('名称、代码和接口地址不能为空')
  }

  const prisma = await getPrisma()
  const existing = await prisma.apiProvider.findUnique({ where: { code } })
  if (existing) {
    throw new Error('Provider 代码已存在')
  }

  const provider = await prisma.apiProvider.create({
    data: {
      name,
      code,
      baseUrl,
      apiKey: apiKey || null,
      configSchema: configSchema || null,
      adapterId: adapterId || null,
      configJson: configJson || null,
      isActive: isActive ?? true,
    },
  })

  return serializeProvider(provider)
})
