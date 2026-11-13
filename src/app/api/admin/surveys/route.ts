import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, parsePagination, ApiHandlerError } from '@/lib/api-handler'
import { DEFAULT_SURVEY_QUESTIONS } from '@/lib/survey-questions'
import { notifyUsers } from '@/lib/notify'
import { resolveTargetUserIds } from '@/lib/survey-targets'
import type { Prisma } from '@prisma/client'
import type { SurveyQuestion } from '@/lib/survey-questions'

/** 简单校验 questions 数组形状，防止后台保存脏数据导致用户端渲染崩溃 */
function validateQuestions(raw: unknown): SurveyQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiHandlerError('问题列表不能为空')
  const ids = new Set<string>()
  for (const q of raw) {
    const item = q as SurveyQuestion
    if (!item?.id || !item?.title || !item?.type) throw new ApiHandlerError('每道题必须有 id、title、type')
    if (item.type !== 'single' && item.type !== 'multi' && item.type !== 'text') throw new ApiHandlerError(`题目 ${item.id} 的 type 只能是 single/multi/text`)
    if ((item.type === 'single' || item.type === 'multi') && (!Array.isArray(item.options) || item.options.length === 0)) throw new ApiHandlerError(`题目 ${item.id} 是选择题，必须有 options`)
    if (ids.has(item.id)) throw new ApiHandlerError(`题目 id 重复：${item.id}`)
    ids.add(item.id)
  }
  return raw as SurveyQuestion[]
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const prisma = await getPrisma()
  const url = new URL(request.url)
  const { page, pageSize } = parsePagination(url, { maxPageSize: 50 })
  const where: Prisma.SurveyTemplateWhereInput = {}

  const [items, total] = await Promise.all([
    prisma.surveyTemplate.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { responses: true } } },
    }),
    prisma.surveyTemplate.count({ where }),
  ])

  // 首屏统计：总发卷量（按人）+ 总回收量
  const [userTotal, responseTotal] = await Promise.all([
    prisma.user.count({ where: { status: 'NORMAL' } }),
    prisma.surveyResponse.count(),
  ])

  return {
    defaultQuestions: DEFAULT_SURVEY_QUESTIONS,
    summary: { userTotal, responseTotal },
    items: items.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      audience: t.audience,
      targetTeamId: t.targetTeamId,
      isActive: t.isActive,
      rewardPoints: t.rewardPoints,
      rewardGrantedAt: t.rewardGrantedAt?.toISOString() ?? null,
      questionCount: Array.isArray(t.questions) ? t.questions.length : 0,
      responseCount: t._count.responses,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    total, page, pageSize,
  }
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json()
  const { title, description, questions, audience, targetTeamId, rewardPoints } = body ?? {}
  if (!title || typeof title !== 'string') throw new ApiHandlerError('请填写问卷标题')
  // 题目输入是 TextArea 字符串：留空/空白 → 用默认模板；非空 → 尝试 JSON.parse
  // （后台的「题目列表」是个文本框，用户可能粘贴 JSON 字符串，而不是直接传数组）
  let parsed: unknown = questions
  if (typeof questions === 'string') {
    const trimmed = questions.trim()
    if (!trimmed) {
      parsed = DEFAULT_SURVEY_QUESTIONS
    } else {
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new ApiHandlerError('题目格式不对：请粘贴合法的 JSON 数组，或直接留空使用默认模板')
      }
    }
  }
  if (parsed === undefined || parsed === null) parsed = DEFAULT_SURVEY_QUESTIONS
  const validated = validateQuestions(parsed)

  const prisma = await getPrisma()
  const template = await prisma.surveyTemplate.create({
    data: {
      title,
      description: typeof description === 'string' ? description : null,
      questions: JSON.parse(JSON.stringify(validated)),
      audience: audience === 'TEAM' ? 'TEAM' : 'ALL',
      targetTeamId: audience === 'TEAM' && typeof targetTeamId === 'string' ? targetTeamId : null,
      isActive: true,
      rewardPoints: typeof rewardPoints === 'number' && rewardPoints > 0 ? Math.min(rewardPoints, 100000) : 0,
    },
  })
  // 发放通知：让目标用户铃铛里直接看到「有新问卷」，点「前往查看」进答题页
  const targets = await resolveTargetUserIds(template.audience, template.targetTeamId)
  await notifyUsers(targets.map((userId) => ({
    userId,
    kind: 'system' as const,
    title: `新问卷：${template.title}`,
    content: template.description || '请点击前往查看，填写企业 AI 使用情况调研问卷。',
    link: '/user/survey',
  })))

  return { id: template.id }
})
