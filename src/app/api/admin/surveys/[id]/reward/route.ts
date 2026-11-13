import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { adjustPoints } from '@/lib/billing/wallet'
import { notifyUsers } from '@/lib/notify'
import { recordAdminAction } from '@/lib/admin-audit'

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * 一次性发放问卷奖励：
 *   POST /api/admin/surveys/:id/reward
 *
 * 规则：
 *   - 只发给「已提交」的用户（SurveyResponse 存在）
 *   - 每人 rewardPoints 积分，流水 type=BONUS，描述标明问卷
 *   - rewardGrantedAt 防重发：发过一次后本接口拒绝再发（改题目重测也不重复发）
 *   - 发放走 adjustPoints（裸 SQL 原子加），逐人进行；个别人失败不影响其余人
 */
export const POST = apiHandler(async (request: NextRequest, ctx: RouteCtx) => {
  const admin = await requireAuth(request, { admin: true })
  const { id } = await ctx.params
  const prisma = await getPrisma()

  const template = await prisma.surveyTemplate.findUnique({ where: { id } })
  if (!template) throw new ApiHandlerError('问卷不存在', 404)
  if (template.rewardPoints <= 0) throw new ApiHandlerError('该问卷未设置奖励积分')
  if (template.rewardGrantedAt) throw new ApiHandlerError(`奖励已于 ${template.rewardGrantedAt.toLocaleString('zh-CN')} 发放过，不能重复发放`)

  // ⚠️ 防重发必须**原子认领**，不能只靠上面的 `rewardGrantedAt` 读判：
  // 那是「读—再写」的 TOCTOU —— 管理员双击、或两个管理员同时点，两个请求都能读到
  // rewardGrantedAt=null，然后各自对全部答题者 adjustPoints 一遍 = **双倍发奖**
  // （invite/settle.ts 的认领就是这个写法，见其 `claimed.count === 0`）。
  // 用 updateMany 做条件写（rewardGrantedAt 仍为 null 才认领），只有 count=1 的请求能继续发放。
  const claimed = await prisma.surveyTemplate.updateMany({
    where: { id, rewardGrantedAt: null },
    data: { rewardGrantedAt: new Date() },
  })
  if (claimed.count === 0) {
    throw new ApiHandlerError('该问卷奖励正在发放或已发放，请勿重复操作', 409)
  }

  const responses = await prisma.surveyResponse.findMany({
    where: { templateId: id },
    select: { userId: true },
  })
  if (responses.length === 0) throw new ApiHandlerError('还没有人提交，无法发放')

  // 逐人发放：adjustPoints 内部是原子 UPDATE + 流水，失败抛错但不阻断其余人
  const results = await Promise.allSettled(
    responses.map((r) =>
      adjustPoints(r.userId, template.rewardPoints, `问卷奖励：${template.title}`)
    )
  )
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.length - ok

  // 发放奖励是「钱出去」，必须能查到是谁点的（Q-D42）。
  // 这里写**一条批次留痕**而不是逐人 N 条：逐人的到账本身已有 `PointsLog`（含问卷名与积分），
  // 留痕表要回答的是「哪个管理员在什么时候发起了这一批」，逐人复制只会把表冲成噪音。
  // 失败人数必须进 note —— 否则「发了但少发了一批人」事后完全看不出来。
  await recordAdminAction({
    adminId: admin.userId,
    userId: admin.userId,
    action: 'survey_reward_grant',
    note: `发放问卷「${template.title}」奖励：每人 ${template.rewardPoints} 积分，成功 ${ok} 人、失败 ${failed} 人（共 ${responses.length} 名答题者）`,
  })

  await notifyUsers(responses.map((r) => ({
    userId: r.userId,
    kind: 'billing' as const,
    title: `问卷奖励到账：${template.rewardPoints} 积分`,
    content: `感谢参与「${template.title}」，奖励积分已发放至你的账户。`,
    link: '/user/profile',
  })))

  return { granted: ok, failed, pointsPerUser: template.rewardPoints, total: ok * template.rewardPoints }
})
