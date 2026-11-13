import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { adjustPoints } from '@/lib/billing/wallet'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { writeAdminAction } from '@/lib/admin-audit'

export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params

    const { amount, reason } = await request.json()
    const parsedAmount = Number(amount)

    // 积分支持小数（保留 2 位），只要求非 0
    if (!Number.isFinite(parsedAmount) || parsedAmount === 0) {
      throw new ApiHandlerError('调整数量必须是非零整数', 400)
    }

    const prisma = await getPrisma()
    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiHandlerError('用户不存在', 404)
    }
    if (existing.points + parsedAmount < 0) {
      throw new ApiHandlerError('调整后积分不能为负数', 400)
    }

    // 余额变更与留痕必须同事务（Q-D42）：`PointsLog` 里没有操作者列，
    // 「哪个管理员在什么时候把谁的余额改了多少」只存在在这一行留痕里；
    // 分开提交就会出现「钱改了但查不到是谁干的」。
    // `adjustPoints` 本来就接收 tx（内部 withTx），传进来即并入同一事务，金额口径不变。
    await prisma.$transaction(async (tx) => {
      await adjustPoints(id, parsedAmount, reason || null, tx)
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: id,
        action: 'points_adjust',
        note: `管理员调整积分 ${parsedAmount > 0 ? '+' : ''}${parsedAmount}${reason ? `：${reason}` : ''}`,
      })
    })

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        nickname: true,
        role: true,
        status: true,
        points: true,
        billingType: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return success(
      { ...user!, createdAt: user!.createdAt.toISOString(), updatedAt: user!.updatedAt.toISOString() },
      '积分调整成功'
    )
  }
)
