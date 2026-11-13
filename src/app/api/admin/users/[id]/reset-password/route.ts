import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { isPasswordValid, PASSWORD_MIN_LENGTH } from '@/lib/password-policy'
import { writeAdminAction } from '@/lib/admin-audit'

export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const admin = await requireAuth(request, { admin: true })
    const { id } = await params

    const { password } = await request.json()
    if (!isPasswordValid(password)) {
      throw new ApiHandlerError(`密码长度至少为${PASSWORD_MIN_LENGTH}位`, 400)
    }

    const prisma = await getPrisma()
    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiHandlerError('用户不存在', 404)
    }

    const passwordHash = await bcrypt.hash(password, 10)
    // 管理员重置同样作废旧会话：用户求助客服时往往正因为账号被人占用（Q-506）
    //
    // 必须与留痕同事务（Q-D42）：「谁在什么时候重置了谁的密码」是排查账号被占用时
    // 唯一能区分「用户自己改的」和「客服代操作」的证据；
    // 而且这里**不能把新密码写进 note** —— 留痕表是可被读取的记录，不是凭据保管处。
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, tokenVersion: { increment: 1 } } })
      await writeAdminAction(tx, {
        adminId: admin.userId,
        userId: id,
        action: 'password_reset',
        note: `管理员重置了登录密码，并作废该账号的全部既有会话（tokenVersion +1）${existing.phone ? `（账号 ${existing.phone}）` : ''}`,
      })
    })

    return success(null, '密码重置成功')
  }
)
