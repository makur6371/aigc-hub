import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import type { Prisma } from '@prisma/client'
import { isValidMainlandPhone } from '@/lib/phone'
import { uniqueConstraintField } from '@/lib/prisma-errors'
import { writeAdminAction } from '@/lib/admin-audit'
import { randomUUID } from 'node:crypto'
import { grantFreeImageTime } from '@/lib/promotions/free-image-grants'

/**
 * 手机号写进留痕时打码：留痕表是「谁对谁做了什么」的证据链，
 * 不是第二份联系方式存储。前后号段（前 3 后 4）足够确认「换到了哪一个号」，
 * 完整号码在 users 表里本来就有，没必要在日志里再复制一份。
 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '（无）'
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : `${phone.slice(0, 1)}****`
}

/**
 * 删除用户（管理员）。
 * 关联数据（积分流水、生成记录、素材、邀请关系等）在 schema 里多为 onDelete: Cascade，
 * 会随用户一并清除；少数 SetNull 关系（作品/工具/卡密使用人）保留记录但清空归属。
 * 用事务包住，任何一步失败整体回滚，避免删一半留下孤儿数据。
 */
export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request, { admin: true })
    const { id } = await params

    if (id === authUser.userId) {
      throw new ApiHandlerError('不能删除自己的账号', 400)
    }

    const prisma = await getPrisma()
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true, nickname: true, role: true },
    })
    if (!existing) {
      throw new ApiHandlerError('用户不存在', 404)
    }

    // 充值订单是财务审计凭证，不能随用户级联删除。
    // 有订单的账号只能冻结或停用，不能物理删除；否则真实支付记录会永久消失。
    const rechargeOrderCount = await prisma.rechargeOrder.count({ where: { userId: id } })
    if (rechargeOrderCount > 0) {
      throw new ApiHandlerError('该用户存在充值订单，财务记录不可删除；请改为冻结账号', 409)
    }

    try {
      await prisma.$transaction(async (tx) => {
        // 留痕指向**被删的那个用户**（Q-D42）。
        // 旧注释说「userId 关联被删用户，删除后会随 Cascade 消失」—— 实测**不成立**：
        // `admin_action_logs` 只有一条外键 `admin_id → users.id CASCADE`，
        // `user_id` 是纯列、没有外键（生产库 `pragma foreign_key_list` 与
        // 「已有 1 行 user_id 指向不存在的账号」都证实了这一点）。
        // 所以这里不需要再把被删对象编码进 action 字符串（那种写法会让动作码无法统计）。
        // 但因为删号后这一行 join 不回任何人，身份必须写进 note。
        await writeAdminAction(tx, {
          adminId: authUser.userId,
          userId: id,
          action: 'delete_user',
          note: `管理员删除了账号（原手机号 ${maskPhone(existing.phone)}、昵称「${existing.nickname || '未命名'}」、角色 ${existing.role}）`,
        })
        await tx.user.delete({ where: { id } })
      })
    } catch (err) {
      console.error('[admin/users] 删除用户失败:', err)
      throw new ApiHandlerError('删除失败：该用户存在无法级联清除的关联数据', 409)
    }

    return success({ id }, '用户已删除')
  }
)

export const PUT = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request, { admin: true })
    const { id } = await params

    const body = await request.json()
    const prisma = await getPrisma()

    const existing = await prisma.user.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiHandlerError('用户不存在', 404)
    }

    if (body.role && !['USER', 'ADMIN'].includes(body.role)) {
      throw new ApiHandlerError('角色无效', 400)
    }
    if (body.status && !['NORMAL', 'FROZEN'].includes(body.status)) {
      throw new ApiHandlerError('状态无效', 400)
    }

    if (id === authUser.userId) {
      if (body.status === 'FROZEN') {
        throw new ApiHandlerError('不能冻结自己的账号', 400)
      }
      if (body.role === 'USER') {
        throw new ApiHandlerError('不能取消自己的管理员权限', 400)
      }
    }

    // 订阅管理（替代旧的 billingType 直改——直改会造出无到期时间的脏订阅，被惰性检查立刻回滚）：
    // - subscriptionDays（正整数）：手动续期，到期 = max(当前到期, now) + N 天，不赠送积分（积分走"调整积分"）
    // - cancelSubscription：取消订阅，回滚 POINTS 并清到期（已发放积分保留）
    const wantExtend = typeof body.subscriptionDays === 'number' && body.subscriptionDays > 0
    const wantCancel = body.cancelSubscription === true
    if (wantExtend && wantCancel) {
      throw new ApiHandlerError('续期与取消不能同时操作', 400)
    }

    const data: Prisma.UserUpdateInput = {}
    if (body.nickname !== undefined) data.nickname = body.nickname
    if (body.role !== undefined) data.role = body.role
    if (body.status !== undefined) data.status = body.status
    // 管理员人工绑定/改绑手机号（兜底：新号段未收录或用户无法自助完成时）
    if (body.phone !== undefined) {
      const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
      if (phone && !isValidMainlandPhone(phone)) {
        throw new ApiHandlerError('手机号格式无效', 400)
      }
      if (phone) {
        const occupied = await prisma.user.findFirst({ where: { phone, NOT: { id } }, select: { id: true } })
        if (occupied) {
          throw new ApiHandlerError('该手机号已绑定其他账号', 409)
        }
      }
      data.phone = phone || null
    }

    // 管理员解绑微信（兜底：用户换号/微信绑错账号，导致「该微信已绑定其他账号」死锁时）
    // 解绑后该 OpenID 释放，可重新绑定到正确账号。
    if (body.unbindWechat === true) {
      if (!existing.socialUid) {
        throw new ApiHandlerError('该用户未绑定微信', 400)
      }
      data.socialUid = null
      data.socialProvider = null
    }

    let subscriptionNote: string | null = null
    let freeImageNote: string | null = null
    if (wantExtend) {
      const days = Math.round(body.subscriptionDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new ApiHandlerError('续期天数需为 1~3650 的整数', 400)
      }
      const now = new Date()
      const base =
        existing.subscriptionExpiryAt && existing.subscriptionExpiryAt > now
          ? existing.subscriptionExpiryAt
          : now
      const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
      data.billingType = 'SUBSCRIPTION'
      data.subscriptionExpiryAt = newExpiry
      if (!existing.subscriptionActivatedAt) data.subscriptionActivatedAt = now
      subscriptionNote = `管理员手动续期订阅 ${days} 天`
    } else if (wantCancel) {
      if (existing.billingType !== 'SUBSCRIPTION' && !existing.subscriptionExpiryAt) {
        throw new ApiHandlerError('该用户没有生效中的订阅', 400)
      }
      data.billingType = 'POINTS'
      data.subscriptionExpiryAt = null
      subscriptionNote = '管理员手动取消订阅（积分保留）'
    }

    if (typeof body.freeImageDays === 'number' && body.freeImageDays > 0) {
      const days = Math.round(body.freeImageDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new ApiHandlerError('免费生图天数需为 1~3650 的整数', 400)
      }
      freeImageNote = `管理员赠送生图时长 ${days} 天`
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data })
        if (freeImageNote) {
          await grantFreeImageTime({ userId: id, source: 'ADMIN', sourceKey: randomUUID(), minutes: Math.round(body.freeImageDays) * 1440, description: freeImageNote, operatorId: authUser.userId, tx })
        }
        // 订阅变更留痕（amount=0 仅作审计流水，不动积分）
        for (const note of [subscriptionNote, freeImageNote]) {
          if (!note) continue
          await tx.pointsLog.create({
            data: { userId: id, amount: 0, type: 'ADMIN_ADJUST', description: note },
          })
        }
        // 账号级变更必须留痕（Q-D42）：这个入口能**授予 ADMIN 角色**、冻结账号、
        // 改绑手机号、解绑微信、续期/取消订阅 —— 全是「出了事必须查得到是谁干的」的操作。
        // 原先只有订阅那一条走了 pointsLog（且不含操作者），其余一律无痕。
        const changes: string[] = []
        if (body.role !== undefined && body.role !== existing.role) changes.push(`角色 ${existing.role}→${body.role}`)
        if (body.status !== undefined && body.status !== existing.status) changes.push(`状态 ${existing.status}→${body.status}`)
        if (body.nickname !== undefined) changes.push(`昵称改为「${String(body.nickname).slice(0, 30) || '空'}」`)
        if (data.phone !== undefined) changes.push(`手机号 ${maskPhone(existing.phone)}→${maskPhone(typeof body.phone === 'string' ? body.phone.trim() : '')}`)
        if (data.socialUid !== undefined) changes.push('解绑微信')
        if (subscriptionNote) changes.push(subscriptionNote)
        if (freeImageNote) changes.push(freeImageNote)
        await writeAdminAction(tx, {
          adminId: authUser.userId,
          userId: id,
          action: 'user_update',
          note: changes.length ? `管理员修改账号：${changes.join('；')}` : '管理员保存账号（无实际字段变化）',
        })
      })
    } catch (err) {
      // 竞态兜底：管理员改绑手机号时并发撞 UNIQUE(phone)
      const field = uniqueConstraintField(err)
      if (field === 'phone') {
        throw new ApiHandlerError('该手机号已绑定其他账号', 409)
      }
      if (field === 'email') {
        throw new ApiHandlerError('该邮箱已被其他账号使用', 409)
      }
      throw err
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
        billingType: true,
        subscriptionExpiryAt: true,
        freeImageUntil: true,
        socialUid: true,
        socialProvider: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return success(
      {
        ...user,
        subscriptionExpiryAt: user?.subscriptionExpiryAt?.toISOString() ?? null,
        freeImageUntil: user?.freeImageUntil?.toISOString() ?? null,
        createdAt: user?.createdAt.toISOString(),
        updatedAt: user?.updatedAt.toISOString(),
      },
      '更新成功'
    )
  }
)
