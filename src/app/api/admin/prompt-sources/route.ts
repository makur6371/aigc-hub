import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success, ApiHandlerError } from '@/lib/api-handler'
import { BUILTIN_PROMPT_SOURCES, PROMPT_REGISTRY_HOMEPAGE } from '@/lib/prompt-sources'
import { ensureBuiltinPromptSources } from '@/lib/prompt-source-store'

// GET /api/admin/prompt-sources - 提示词源列表（管理员）
//
// 首次访问时幂等播种内置源：这样后台一打开就有 7 个源可拉，
// 不需要额外的部署脚本或手工建数据。
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  await ensureBuiltinPromptSources()

  const prisma = await getPrisma()
  const sources = await prisma.promptSource.findMany({ orderBy: [{ builtIn: 'desc' }, { createdAt: 'asc' }] })

  // 每个源的已入库条数（实时统计，不依赖 lastCount，后者可能因失败而滞后）
  const counts = await prisma.promptTemplate.groupBy({
    by: ['sourceId'],
    _count: { _all: true },
    where: { sourceId: { in: sources.map((s) => s.id) } },
  })
  const countMap = new Map(counts.map((c) => [c.sourceId, c._count._all]))

  return {
    registryHomepage: PROMPT_REGISTRY_HOMEPAGE,
    builtinCount: BUILTIN_PROMPT_SOURCES.length,
    items: sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      homepage: s.homepage,
      enabled: s.enabled,
      builtIn: s.builtIn,
      cacheCover: s.cacheCover,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      lastCount: s.lastCount,
      lastPulledAt: s.lastPulledAt?.toISOString() || null,
      promptCount: countMap.get(s.id) ?? 0,
      createdAt: s.createdAt.toISOString(),
    })),
  }
})

// POST /api/admin/prompt-sources - 新增自定义源
export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json()
  const name = String(body.name || '').trim()
  const url = String(body.url || '').trim()
  if (!name) throw new ApiHandlerError('名称不能为空', 400)
  if (!/^https?:\/\//i.test(url)) throw new ApiHandlerError('URL 必须是 http(s) 地址', 400)

  const prisma = await getPrisma()
  const dup = await prisma.promptSource.findFirst({ where: { name } })
  if (dup) throw new ApiHandlerError('同名来源已存在', 400)

  const created = await prisma.promptSource.create({
    data: {
      name,
      url,
      homepage: body.homepage ? String(body.homepage).trim() : null,
      enabled: body.enabled !== false,
      cacheCover: body.cacheCover !== false,
      builtIn: false,
    },
  })
  return success({ id: created.id }, '已新增来源')
})
