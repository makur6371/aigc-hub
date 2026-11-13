import type { Prisma } from '@prisma/client'
import { getPrisma } from '@/lib/prisma'
import { errorRecord, recordError } from '@/lib/error-sink'

/**
 * 管理操作留痕（`admin_action_logs`）的**唯一写入入口**（Q-D42）。
 *
 * ===== 为什么必须有这一层 =====
 * 留痕原先是各路由手写 `prisma.adminActionLog.create`，全库只有 4 个文件这么写：
 * 调积分、调豆、重置他人密码、扣回返利、审核工具/作品、改价格档位 —— **全都零留痕**。
 * 生产库实查（2026-11-01）整张表只有 8 行，而平台已有 43 个账号。
 * 更糟的是 `PointsLog` 里根本没有操作者列 —— 「谁改的」这一维**在数据层就缺失**，
 * 于是「管理员改错余额 / 误重置密码 / 内部纠纷」事后拿不出任何证据链。
 *
 * 逐个路由补 `create` 是治不了这一类的：下一个新增的后台写接口照样会漏。
 * 所以这里收成一份实现，并由 `tests/admin-audit.test.ts` 的源码守卫钉住
 * 「路由里不许再出现裸的 `adminActionLog.create`」。
 *
 * ===== 两个入口，差别是「要不要把留痕和业务绑成一个事务」 =====
 * - `writeAdminAction(tx, …)`：**事务内用，会抛错**。涉钱 / 涉账号的操作必须用它 ——
 *   钱动了但没留痕＝没证据；留痕写了但钱没动＝假证据。两种都不可接受，所以同生同死。
 *   `wallet.adjustPoints/adjustBeans` 本来就接收 `tx`，调用方把它们和留痕包进同一个
 *   `$transaction` 即可（工具/作品审核此前是「先改状态、再发奖励」两步分开提交，
 *   中间崩一次就留下「已 APPROVED 但作者没拿到奖励」的哑账，本批同批收口）。
 * - `recordAdminAction(…)`：**事务外「顺带记一笔」，永不抛错**，失败落进错误面板。
 *   用于业务已经落库、留痕只是附带的场景。这里绝不能让抛错冒到调用方：
 *   状态已经改了却给管理员返回 500，管理员会以为没成功而**重试一次**，
 *   于是「审核通过」变成两次状态变更 —— 留痕失败不该制造比留痕缺失更大的事故。
 *   代价是留痕可能缺行，所以失败必须**在面板上看得见**（对齐 Q-D32/Q-D40 的口径）。
 *
 * ===== 一个已核实的事实（纠正旧注释） =====
 * `admin_action_logs.user_id` **不是外键**（生产库 `pragma foreign_key_list` 只有一条：
 * `admin_id → users.id ON DELETE CASCADE`）。所以：
 *   - 把留痕指向「被操作的那个用户」，**不会**因为他被删除而消失 ——
 *     `admin/users/[id]` 里「删除后会随 Cascade 消失」的注释是错的，本批已改；
 *     但删号后这一行 join 不回任何人，所以**身份必须写进 note**；
 *   - 反过来，**删掉某个管理员账号会级联删掉他名下的全部留痕**（证据可被销毁）。
 *     这需要把 `admin_id` 改成 `onDelete: SetNull` 并放开可空，属生产库结构变更，
 *     登记为 Q-D54 单独一批做（按 `docs/DEPLOY_RUNBOOK.md` 先备份再演练恢复）。
 */

/**
 * 只声明真正用到的那一个方法。
 *
 * 为什么不直接写 `Prisma.TransactionClient`：那是**整个事务句柄**（几十张表 + $executeRaw），
 * 用它当参数等于要求调用方交出整个连接，而留痕只需要往一张表插一行。
 * 收窄成方法级接口后：prisma 客户端与 `$transaction` 回调里的 tx 都能传（结构匹配即可），
 * 测试里一个 `{ create }` 的替身也能直接喂进来 —— 不用为了过编译去伪造整个 delegate。
 */
export type AdminLogWriter = {
  adminActionLog: {
    create: (args: { data: Prisma.AdminActionLogUncheckedCreateInput }) => Promise<unknown>
  }
}

export type AdminAction = {
  /** 谁做的（管理员 userId） */
  adminId: string
  /** 对谁做的（被操作 / 受影响的用户） */
  userId: string
  /** 做了什么：稳定机器码，snake_case，用于事后按动作统计。改名等于销毁历史查询。 */
  action: string
  /** 人话说明 + 必要上下文（金额、对象名、原因）。被删账号的身份也只能靠它留存。 */
  note?: string | null
}

/** note 上限：留痕是证据不是文章，超长截断好过写入失败。 */
const NOTE_MAX = 500
const ACTION_MAX = 40

/**
 * 动作码必须是小写 snake_case：`points_adjust`、`team_member_remove` …
 *
 * 为什么要把「不许含冒号/空格」写成硬规则 —— 旧代码里有
 * `action: \`delete_user:${id}:${phone}\``，把被操作对象的身份编码进了动作码。
 * 那样这张表就**没法按动作统计**了（每一行的 action 都不同），
 * 而「按动作统计谁干过什么」正是这张表存在的理由。身份属于 note，不属于 action。
 */
const ACTION_PATTERN = /^[a-z][a-z0-9_]*$/

function toRecord(input: AdminAction): Prisma.AdminActionLogUncheckedCreateInput {
  const adminId = (input.adminId || '').trim()
  const userId = (input.userId || '').trim()
  const action = (input.action || '').trim()
  // 缺字段的留痕在事后查起来与没有留痕等价（不知道是谁、对谁、做了什么），
  // 所以这里**宁可抛错**也不能写一条空壳记录进去污染统计。
  if (!adminId) throw new Error('管理留痕缺 adminId（谁做的）')
  if (!userId) throw new Error(`管理留痕缺 userId（对谁做的）：action=${action || '(空)'}`)
  if (!action) throw new Error('管理留痕缺 action（做了什么）')
  if (action.length > ACTION_MAX) {
    throw new Error(`管理留痕 action 过长（>${ACTION_MAX}）：${action.slice(0, 24)}…`)
  }
  if (!ACTION_PATTERN.test(action)) {
    throw new Error(`管理留痕 action 必须是 snake_case（小写字母开头，只含 a-z0-9_）：${action}`)
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_MAX) : null
  return { adminId, userId, action, note: note || null }
}

/**
 * 事务内写留痕：会抛错，与同事务的业务写操作一起回滚。
 * 涉钱 / 涉账号一律用它，别用 `recordAdminAction` 兜「尽力而为」。
 */
export async function writeAdminAction(tx: AdminLogWriter, input: AdminAction): Promise<void> {
  await tx.adminActionLog.create({ data: toRecord(input) })
}

/**
 * 事务外写留痕：永不抛错，失败进错误面板（scope=`admin-audit`）。
 * 只在「业务已落库、留痕是附带」的地方用；调用方自己就在事务里时请用 `writeAdminAction`。
 */
export async function recordAdminAction(input: AdminAction): Promise<void> {
  try {
    const prisma = await getPrisma()
    await writeAdminAction(prisma, input)
  } catch (err) {
    console.error(`[admin-audit] 留痕写入失败 action=${input.action} target=${input.userId}:`, err)
    const rec = errorRecord('admin-audit', err)
    // 把「哪一笔留痕没落地」拼进 message：面板只有 stack 的话，
    // 运维知道在报错但不知道丢了哪条证据，等于还是要靠人翻日志反推。
    rec.message = `留痕写入失败 action=${input.action} target=${input.userId} admin=${input.adminId}：${rec.message}`
    recordError(rec)
  }
}

/** 供测试与守卫使用：确认这份实现真的只有这两个出口。 */
export const __internals = { NOTE_MAX, ACTION_MAX }
