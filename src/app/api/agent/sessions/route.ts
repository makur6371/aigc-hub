import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { success } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

// GET /api/agent/sessions - 当前用户的 Agent 会话列表（带最后一条消息预览）
export async function GET(request: NextRequest) {
  const auth = await getAuthUser(request)
  if (!auth) return Response.json({ success: false, data: null, message: '未登录' }, { status: 401 })

  const prisma = await getPrisma()
  const sessions = await prisma.chatSession.findMany({
    where: { userId: auth.userId, status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
    take: 30,
    select: { id: true, title: true, updatedAt: true },
  })

  // 批量取每个会话最后一条用户消息作预览
  const items = await Promise.all(sessions.map(async (s) => {
    const last = await prisma.chatMessage.findFirst({
      where: { sessionId: s.id, role: 'user' },
      orderBy: { seq: 'desc' },
      select: { content: true },
    })
    return { id: s.id, title: s.title, preview: last?.content?.slice(0, 50) || '', updatedAt: s.updatedAt.toISOString() }
  }))

  return Response.json({ success: true, data: items })
}
