import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success, ApiHandlerError } from '@/lib/api-handler'

type Ctx = { id: string }

// PATCH /api/admin/prompt-sources/[id] - 编辑源（内置源只允许改 enabled/cacheCover/url）
export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  await requireAuth(request, { admin: true })
  const { id } = await params
  const body = await request.json()

  const prisma = await getPrisma()
  const source = await prisma.promptSource.findUnique({ where: { id } })
  if (!source) throw new ApiHandlerError('来源不存在', 404)

  const data: Record<string, unknown> = {}
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled)
  if (body.cacheCover !== undefined) data.cacheCover = Boolean(body.cacheCover)
  if (body.url !== undefined) {
    const url = String(body.url).trim()
    if (!/^https?:\/\//i.test(url)) throw new ApiHandlerError('URL 必须是 http(s) 地址', 400)
    data.url = url
  }
  // 内置源的名称/主页固定，避免改乱后无法与注册表对齐
  if (!source.builtIn) {
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) throw new ApiHandlerError('名称不能为空', 400)
      data.name = name
    }
    if (body.homepage !== undefined) data.homepage = body.homepage ? String(body.homepage).trim() : null
  }

  await prisma.promptSource.update({ where: { id }, data })
  return success(null, '已保存')
})

// DELETE /api/admin/prompt-sources/[id] - 删除自定义源（内置源不可删）
export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  await requireAuth(request, { admin: true })
  const { id } = await params

  const prisma = await getPrisma()
  const source = await prisma.promptSource.findUnique({ where: { id } })
  if (!source) throw new ApiHandlerError('来源不存在', 404)
  if (source.builtIn) throw new ApiHandlerError('内置来源不可删除，请改为停用', 400)

  // 只删源，保留已入库的提示词（解绑 sourceId），避免误删连带清空内容
  await prisma.promptTemplate.updateMany({ where: { sourceId: id }, data: { sourceId: null } })
  await prisma.promptSource.delete({ where: { id } })
  return success(null, '已删除来源（已入库的提示词保留）')
})
