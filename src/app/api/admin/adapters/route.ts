import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { ADAPTER_TEMPLATES } from '@/lib/adapters/vendors'

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })

  const url = new URL(request.url)
  // ?templates=1 → 返回可预置的多厂商模板（管理后台「从模板新建」）
  if (url.searchParams.get('templates') === '1') {
    return ADAPTER_TEMPLATES.map((t) => ({
      code: t.code,
      name: t.name,
      description: t.description,
      source: t.source,
    }))
  }

  const prisma = await getPrisma()

  const adapters = await prisma.providerAdapter.findMany({
    // 启用的排在前面（与 providers 同一口径）：停用的适配器不该混在时间线里，
    // 管理员排查「哪个适配器在生效」时应该一眼看到。
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  })

  return adapters.map((a) => ({
    ...a,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }))
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })

  const { name, code, description, type = 'TYPESCRIPT', source, isActive = true } = await request.json()

  if (!name || !code || !source) {
    throw new ApiHandlerError('名称、代码和源码不能为空', 400)
  }
  if (!['TYPESCRIPT', 'JSON'].includes(type)) {
    throw new ApiHandlerError('类型必须是 TYPESCRIPT 或 JSON', 400)
  }

  const prisma = await getPrisma()

  const existing = await prisma.providerAdapter.findFirst({
    where: { OR: [{ code }, { name }] },
  })
  if (existing) {
    throw new ApiHandlerError('适配器代码或名称已存在', 400)
  }

  const adapter = await prisma.providerAdapter.create({
    data: {
      name: String(name),
      code: String(code),
      description: description ? String(description) : null,
      type,
      source: String(source),
      isActive: Boolean(isActive),
      isBuiltin: false,
    },
  })

  return success(
    { ...adapter, createdAt: adapter.createdAt.toISOString(), updatedAt: adapter.updatedAt.toISOString() },
    '创建成功'
  )
})
