import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import type { SurveyQuestion } from '@/lib/survey-questions'

/**
 * 用户端调研接口（登录用户自己可见的问卷）：
 *   GET  /api/user/survey            → 我可见的活跃问卷列表（含我的提交状态）
 *   POST /api/user/survey            → 提交/覆盖我的回答（templateId + answers）
 *
 * 可见规则：audience=ALL → 全站 NORMAL 用户；audience=TEAM → 我是 owner 或 billingOwnerId=owner 的成员。
 * 已提交过的问卷仍可见（可再次进入查看），但 answers 已存在时 POST 走 upsert 覆盖（树形结构整体替换）。
 */

export const GET = apiHandler(async (request: NextRequest) => {
  const { userId } = await requireAuth(request)
  const prisma = await getPrisma()

  const templates = await prisma.surveyTemplate.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { responses: { where: { userId }, select: { answers: true, submittedAt: true } } },
  })

  // 按用户身份过滤可见性
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { billingOwnerId: true, status: true } })
  if (!me || me.status !== 'NORMAL') return { items: [] }

  const items = templates
    .filter((t) => t.audience === 'ALL' || (t.audience === 'TEAM' && (t.targetTeamId === me.billingOwnerId || t.targetTeamId === userId)))
    .map((t) => {
      const mine = t.responses[0]
      const questions = (t.questions as unknown as SurveyQuestion[]) ?? []
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        questionCount: questions.length,
        questions,
        submittedAt: mine?.submittedAt?.toISOString() ?? null,
        answeredCount: mine ? Object.keys((mine.answers as Record<string, unknown>) ?? {}).length : 0,
      }
    })

  return { items }
})

export const POST = apiHandler(async (request: NextRequest) => {
  const { userId } = await requireAuth(request)
  const body = await request.json()
  const { templateId, answers } = body ?? {}
  if (typeof templateId !== 'string' || !templateId) throw new ApiHandlerError('缺少 templateId')
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) throw new ApiHandlerError('answers 必须是对象')

  const prisma = await getPrisma()
  const template = await prisma.surveyTemplate.findUnique({ where: { id: templateId } })
  if (!template || !template.isActive) throw new ApiHandlerError('问卷不存在或已下线', 404)

  // 权限：同可见规则
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { billingOwnerId: true, status: true } })
  if (!me || me.status !== 'NORMAL') throw new ApiHandlerError('账号不可用', 403)
  const canSee = template.audience === 'ALL'
    || (template.audience === 'TEAM' && (template.targetTeamId === me.billingOwnerId || template.targetTeamId === userId))
  if (!canSee) throw new ApiHandlerError('该问卷不对你开放', 403)

  // 校验 answers 的 key 都在题目里、值类型正确（多选必须是数组）
  const questions = (template.questions as unknown as SurveyQuestion[]) ?? []
  const qMap = new Map(questions.map((q) => [q.id, q]))
  const clean: Record<string, string | string[]> = {}
  for (const [qid, val] of Object.entries(answers as Record<string, unknown>)) {
    const q = qMap.get(qid)
    if (!q) continue
    if (q.type === 'multi') {
      if (Array.isArray(val) && val.every((v) => typeof v === 'string')) {
        clean[qid] = q.max ? val.slice(0, q.max) : val
      }
    } else {
      if (typeof val === 'string') clean[qid] = val
    }
  }

  const saved = await prisma.surveyResponse.upsert({
    where: { templateId_userId: { templateId, userId } },
    create: { templateId, userId, answers: clean, submittedAt: new Date() },
    update: { answers: clean, submittedAt: new Date() },
  })

  return { id: saved.id, submittedAt: saved.submittedAt.toISOString(), answeredCount: Object.keys(clean).length }
})
