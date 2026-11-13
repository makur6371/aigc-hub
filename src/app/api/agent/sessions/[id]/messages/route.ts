import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { success } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

// GET /api/agent/sessions/[id]/messages - 加载某会话的全部消息（回显历史）
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(request)
  if (!auth) return Response.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  const { id } = await params

  const prisma = await getPrisma()
  const session = await prisma.chatSession.findFirst({ where: { id, userId: auth.userId } })
  if (!session) return Response.json({ success: false, data: null, message: '会话不存在' }, { status: 404 })

  const msgs = await prisma.chatMessage.findMany({
    where: { sessionId: id },
    orderBy: { seq: 'asc' },
    take: 100,
    select: { id: true, role: true, content: true, status: true, mediaType: true, mediaUrls: true, meta: true, createdAt: true },
  })

  return Response.json({
    success: true,
    data: {
      sessionId: id,
      title: session.title,
      // meta 原样交给前端做归一化（src/lib/agent-message.ts）。
      // 这里刻意**不再**摆字段：以前 error 被写死成 null，而真实原因一直在
      // meta.error 里 —— 于是失败消息重开历史后只剩「生成失败，请重试」，
      // 具体原因（上游报什么）看不到。字段该由消费方按同一套规则取。
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        status: m.status === 'FAILED' ? 'failed' : 'done',
        mediaUrls: m.mediaUrls ? JSON.parse(m.mediaUrls) : [],
        meta: m.meta ? JSON.parse(m.meta) : null,
      })),
    },
  })
}
