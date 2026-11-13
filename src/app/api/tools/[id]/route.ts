import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'
import { reconcileParamSlots, type ToolSlot, type ToolNodeSnapshot, type ToolConnectionSnapshot } from '@/lib/tool-slots'

type Ctx = { params: Promise<{ id: string }> }

// ===== 工具详情（含 workflow 快照 + slots；执行页/Remix 用） =====
export const GET = apiHandler(async (_request: NextRequest, ctx: Ctx) => {
  const prisma = await getPrisma()
  const { id } = await ctx.params
  const tool = await prisma.tool.findFirst({
    where: { OR: [{ id }, { slug: id }] },
    include: { author: { select: { id: true, nickname: true, avatarUrl: true } } },
  })
  if (!tool) throw new (await import('@/lib/api-handler')).ApiHandlerError('工具不存在', 404)
  // 未过审只对作者/管理员可见
  if (tool.status !== 'APPROVED') {
    const authUser = await requireAuth(_request)
    if (authUser.userId !== tool.authorId && authUser.role !== 'ADMIN') {
      // 已下架且**有承接方** → 返回迁移指引（HTTP 200 + retired 标记），
      // 让前端能显示「这个功能搬到哪了」，而不是一句「未上架」把用户挡在门外。
      //
      // 为什么用 200 而不是 403：403 只能表达「你没权限看」，
      // 但下架是**产品决定**、对所有人一样 —— 对普通用户来说它不是权限问题，
      // 而是「我该去哪」。返回迁移信息，前端据此渲染引导页。
      const { findRetiredMigration } = await import('@/lib/retired-tools')
      const migration = findRetiredMigration(tool.slug)
      if (migration) {
        return success({
          id: tool.id,
          slug: tool.slug,
          name: tool.name,
          description: tool.description,
          status: tool.status,
          retired: true,
          migration,
        })
      }
      throw new (await import('@/lib/api-handler')).ApiHandlerError('该工具审核中，暂不可见', 403)
    }
  }
  return success({
    ...tool,
    workflow: tool.workflow as unknown as { nodes: unknown[]; connections: unknown[] },
    // 参数槽（model/ratio）以最新识别结果为准：老工具发布时识别引擎还不支持「同组共享槽」，
    // 快照里覆盖不全会导致「只给第一个节点选了模型，其余自动兜底」。
    slots: reconcileParamSlots(
      (tool.workflow as unknown as { nodes: ToolNodeSnapshot[] }).nodes ?? [],
      (tool.workflow as unknown as { connections: ToolConnectionSnapshot[] }).connections ?? [],
      (tool.slots as unknown as ToolSlot[]) ?? [],
    ),
  })
})

// ===== 删除（作者本人或管理员） =====
export const DELETE = apiHandler(async (request: NextRequest, ctx: Ctx) => {
  const authUser = await requireAuth(request)
  const { id } = await ctx.params
  const prisma = await getPrisma()
  const tool = await prisma.tool.findUnique({ where: { id } })
  if (!tool) throw new (await import('@/lib/api-handler')).ApiHandlerError('工具不存在', 404)
  if (authUser.userId !== tool.authorId && authUser.role !== 'ADMIN') {
    throw new (await import('@/lib/api-handler')).ApiHandlerError('无权限', 403)
  }
  await prisma.tool.delete({ where: { id } })
  return success(null, '已删除')
})
