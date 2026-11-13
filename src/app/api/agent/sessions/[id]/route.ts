import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

// PATCH /api/agent/sessions/[id] - 重命名会话
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(request)
  if (!auth) return Response.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  const { id } = await params
  const body = await request.json().catch(() => null) as { title?: string } | null
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 50) : ''
  if (!title) return Response.json({ success: false, data: null, message: '标题不能为空' }, { status: 400 })

  const prisma = await getPrisma()
  const session = await prisma.chatSession.findFirst({ where: { id, userId: auth.userId }, select: { id: true } })
  if (!session) return Response.json({ success: false, data: null, message: '会话不存在' }, { status: 404 })

  await prisma.chatSession.update({ where: { id }, data: { title } })
  return Response.json({ success: true, data: { id, title } })
}

// DELETE /api/agent/sessions/[id] - 删除会话及其消息
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(request)
  if (!auth) return Response.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  const { id } = await params

  const prisma = await getPrisma()
  const session = await prisma.chatSession.findFirst({ where: { id, userId: auth.userId }, select: { id: true } })
  if (!session) return Response.json({ success: false, data: null, message: '会话不存在' }, { status: 404 })

  await prisma.chatMessage.deleteMany({ where: { sessionId: id } })
  await prisma.chatSession.delete({ where: { id } })
  return Response.json({ success: true, data: { id } })
}
