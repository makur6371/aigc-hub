import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { adjustBeans } from '@/lib/billing/wallet'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { writeAdminAction } from '@/lib/admin-audit'

/**
 * 管理员调整视频豆（与 /points 对称）。
 *
 * 此前豆没有后台调整入口，管理员只能改积分、无法处理视频额度诉求；
 * 且豆的变动缺少统一入口就容易退化成「裸写 beansLog」，绕过 wallet 的余额校验与事务。
 * 这里统一走 wallet.adjustBeans：条件扣减防并发扣负 + 自动写 ADMIN_ADJUST 流水。
 */
export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params

    const { amount, reason } = await request.json()
    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount === 0) {
      throw new ApiHandlerError('调整数量必须是非零数值', 400)
    }

    const prisma = await getPrisma()
    const existing = await prisma.user.findUnique({ where: { id }, select: { beans: true } })
    if (!existing) {
      throw new ApiHandlerError('用户不存在', 404)
    }
    if (existing.beans + parsedAmount < 0) {
      throw new ApiHandlerError('调整后视频豆不能为负数', 400)
    }

    try {
      // 与 /points 对称：余额变更 + 留痕同事务（Q-D42）
      await prisma.$transaction(async (tx) => {
        await adjustBeans(id, parsedAmount, reason || null, tx)
        await writeAdminAction(tx, {
          adminId: admin.userId,
          userId: id,
          action: 'beans_adjust',
          note: `管理员调整视频豆 ${parsedAmount > 0 ? '+' : ''}${parsedAmount}${reason ? `：${reason}` : ''}`,
        })
      })
    } catch (err) {
      throw new ApiHandlerError(err instanceof Error ? err.message : '视频豆调整失败', 400)
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        nickname: true,
        role: true,
        status: true,
        points: true,
        beans: true,
        billingType: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return success(
      { ...user!, createdAt: user!.createdAt.toISOString(), updatedAt: user!.updatedAt.toISOString() },
      '视频豆调整成功',
    )
  },
)
