import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { Prisma } from '@prisma/client'
import { SurveyQuestion } from '@/lib/survey-questions'

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * 单份问卷管理：
 *   GET    /api/admin/surveys/:id              → 详情（含题目树）
 *   PATCH  /api/admin/surveys/:id              → 改标题/描述/题目/上下线
 *   DELETE /api/admin/surveys/:id              → 删除
 *   GET    /api/admin/surveys/:id?format=csv   → 导出回答 CSV
 */
export const GET = apiHandler(async (request: NextRequest, ctx: RouteCtx) => {
  await requireAuth(request, { admin: true })
  const { id } = await ctx.params
  const prisma = await getPrisma()
  const url = new URL(request.url)

  const template = await prisma.surveyTemplate.findUnique({ where: { id } })
  if (!template) throw new ApiHandlerError('问卷不存在', 404)

  if (url.searchParams.get('format') === 'csv') {
    const responses = await prisma.surveyResponse.findMany({
      where: { templateId: id },
      orderBy: { submittedAt: 'asc' },
      include: { user: { select: { nickname: true, phone: true, email: true } } },
    })
    const questions = (template.questions as unknown as SurveyQuestion[]) ?? []
    const header = ['用户', '手机号', '邮箱', '提交时间', ...questions.map((q) => q.title)]
    const esc = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = responses.map((r) => {
      const answers = (r.answers as Record<string, string | string[]>) ?? {}
      const cells = questions.map((q) => {
        const a = answers[q.id]
        return Array.isArray(a) ? a.join('、') : (a ?? '')
      })
      return [
        r.user?.nickname ?? r.user?.phone ?? r.user?.email ?? r.userId,
        r.user?.phone ?? '',
        r.user?.email ?? '',
        r.submittedAt.toISOString(),
        ...cells,
      ].map(esc).join(',')
    })
    const csv = '\uFEFF' + [header.map(esc).join(','), ...rows].join('\r\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="survey-${id}.csv"`,
      },
    })
  }

  const responseCount = await prisma.surveyResponse.count({ where: { templateId: id } })
  const targetUserIds = await resolveTargetUserIds(prisma, template.audience, template.targetTeamId)

  return {
    id: template.id,
    title: template.title,
    description: template.description,
    audience: template.audience,
    targetTeamId: template.targetTeamId,
    isActive: template.isActive,
    rewardPoints: template.rewardPoints,
    rewardGrantedAt: template.rewardGrantedAt?.toISOString() ?? null,
    questions: template.questions,
    responseCount,
    targetUserCount: targetUserIds.length,
    createdAt: template.createdAt.toISOString(),
  }
})

export const PATCH = apiHandler(async (request: NextRequest, ctx: RouteCtx) => {
  await requireAuth(request, { admin: true })
  const { id } = await ctx.params
  const body = await request.json()
  const prisma = await getPrisma()
  const existing = await prisma.surveyTemplate.findUnique({ where: { id } })
  if (!existing) throw new ApiHandlerError('问卷不存在', 404)

  const data: Prisma.SurveyTemplateUpdateInput = {}
  if (typeof body.title === 'string' && body.title) data.title = body.title
  if (typeof body.description === 'string' || body.description === null) data.description = body.description
  if (typeof body.isActive === 'boolean') data.isActive = body.isActive
  if (body.questions !== undefined) {
    if (!Array.isArray(body.questions) || body.questions.length === 0) throw new ApiHandlerError('问题列表不能为空')
    data.questions = body.questions
  }
  if (body.audience !== undefined) {
    data.audience = body.audience === 'TEAM' ? 'TEAM' : 'ALL'
    data.targetTeamId = body.audience === 'TEAM' && typeof body.targetTeamId === 'string' ? body.targetTeamId : null
  }

  await prisma.surveyTemplate.update({ where: { id }, data })
  return { id }
})

export const DELETE = apiHandler(async (request: NextRequest, ctx: RouteCtx) => {
  await requireAuth(request, { admin: true })
  const { id } = await ctx.params
  const prisma = await getPrisma()
  await prisma.surveyTemplate.delete({ where: { id } })
  return { id }
})

/** 解析一份问卷的目标用户集合：ALL=所有 NORMAL 用户；TEAM=企业 owner + billingOwnerId=owner 的成员 */
async function resolveTargetUserIds(
  prisma: Prisma.TransactionClient | { user: { findMany(args: { where: unknown; select: { id: true } }): Promise<{ id: string }[]> } },
  audience: string,
  teamOwnerId: string | null
): Promise<string[]> {
  if (audience === 'TEAM' && teamOwnerId) {
    const members = await prisma.user.findMany({
      where: { OR: [{ id: teamOwnerId }, { billingOwnerId: teamOwnerId }] },
      select: { id: true },
    })
    return members.map((m) => m.id)
  }
  const users = await prisma.user.findMany({ where: { status: 'NORMAL' }, select: { id: true } })
  return users.map((u) => u.id)
}
