import { getPrisma } from '@/lib/prisma'

/**
 * 站内通知（1 对 1 消息）—— 唯一写入入口。**纯站内，不发邮件**。
 *
 * ===== 为什么必须有这一层 =====
 * 「团队审核通过/驳回」「被加入/移出团队」「被停用」这些事件都发生在**别人的操作**里，
 * 用户不在线、也不一定会主动去看后台。没有通知，用户只能靠「下次生成时突然报错」
 * 或「莫名收到一条消费记录」来发现状态变了 —— 这是体验黑洞。
 *
 * ===== 设计约束（决定了这个实现的形状）=====
 * 1. **只走站内，不做邮件**：实测全站仅 1/34 用户填了邮箱，邮件当通道等于
 *    覆盖率 3%，却在通知写入路径里挂了一条外部依赖（SMTP 超时/失败面）。
 *    站内通知零外部依赖、必达；需要「离开站点也能收到」是**另一个量级**的工程
 *    （Service Worker / 推送），不在当前需求内。
 * 2. **通知失败绝不能影响主流程**。审核动作已经落库了，通知只是附带效果；
 *    这里所有异常吞掉并记日志 —— 不能让「发通知失败」把「审核失败」的假象带给管理员。
 * 3. **读状态在服务端**（readAt）：1 对 1 消息换设备登录也该是已读，
 *    不能像全局公告那样用 localStorage（会出现「这台已读、那台还红点」）。
 */

export interface NotifyInput {
  userId: string
  kind: 'team_review' | 'team_member' | 'billing' | 'system'
  title: string
  content: string
  /** 点击跳转的站内路径 */
  link?: string
}

/** 写站内通知。永不抛错。 */
export async function notifyUser(input: NotifyInput): Promise<void> {
  try {
    const prisma = await getPrisma()
    await prisma.userNotification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title.slice(0, 80),
        content: input.content.slice(0, 1000),
        link: input.link ?? null,
      },
    })
  } catch (err) {
    // 通知失败不影响主流程（审核已落库），只记录
    console.error('[notify] 写站内通知失败:', err instanceof Error ? err.message : err)
  }
}

/** 批量通知（如驳回解绑所有成员：所有人都要知道自己被移出了）。永不抛错。 */
export async function notifyUsers(inputs: NotifyInput[]): Promise<void> {
  if (inputs.length === 0) return
  try {
    const prisma = await getPrisma()
    await prisma.userNotification.createMany({
      data: inputs.map((i) => ({
        userId: i.userId,
        kind: i.kind,
        title: i.title.slice(0, 80),
        content: i.content.slice(0, 1000),
        link: i.link ?? null,
      })),
    })
  } catch (err) {
    console.error('[notify] 批量写站内通知失败:', err instanceof Error ? err.message : err)
  }
}
