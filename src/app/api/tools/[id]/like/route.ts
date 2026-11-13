import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'

type Ctx = { params: Promise<{ id: string }> }

// 点赞/取消赞（不做用户级去重表，P1 简版：toggle 计数）
export const POST = apiHandler(async (request: NextRequest, ctx: Ctx) => {
  await requireAuth(request)
  const { id } = await ctx.params
  const prisma = await getPrisma()
  const body = await request.json().catch(() => ({}))
  const cancel = body?.cancel === true
  const tool = await prisma.tool.update({
    where: { id },
    data: { likeCount: cancel ? { decrement: 1 } : { increment: 1 } },
  }).catch(() => null)
  if (!tool) throw new (await import('@/lib/api-handler')).ApiHandlerError('工具不存在', 404)
  return success({ likeCount: tool.likeCount, liked: !cancel })
})
