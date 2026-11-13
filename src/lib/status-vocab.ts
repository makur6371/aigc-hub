/**
 * 状态词汇表（Q-D46）：裸字符串状态的共享常量层。
 *
 * 为什么不直接上 Prisma enum：status 字段全是 TEXT 列（本地实测词汇零漂移、
 * 10 张表词汇内行数 100%），改 enum 属库结构变更且要 17 张表一起动 —— 收益/
 * 风险比不划算。真正的风险是「写错单词不报错 + 跨表统计各写各的」，
 * 这层用 `as const` 对象解决：键即语义分组，值即字面量；写错或漏改时
 * TS 的字面量类型与下面两条守卫测试都会红。
 *
 * 词汇表按表分组而不是全局一套大写：不同表的语义本来不同
 * （ChatMessage 的 DONE / GenerationRecord 的 SUCCESS / CanvasRun 的 SUCCEEDED
 * 是三个正交状态机），强行统一大词表反而制造第二份翻译层。
 */

/** 生成记录（image/video/audio_generation_records 共用同一套） */
export const MEDIA_RECORD_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const

/** 画布运行（canvas_runs） */
export const CANVAS_RUN_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const

/** Agent 生成任务（generation_tasks） */
export const GENERATION_TASK_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED',
} as const

/** 聊天消息（chat_messages） */
export const CHAT_MESSAGE_STATUS = {
  STREAMING: 'STREAMING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const

/** 充值订单（recharge_orders） */
export const RECHARGE_ORDER_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  CLOSED: 'CLOSED',
} as const

/** 预扣账本（billing_holds） */
export const BILLING_HOLD_STATUS = {
  OPEN: 'OPEN',
  SETTLED: 'SETTLED',
} as const

/** 审核（prompt_templates / shared_works / tools 共用） */
export const REVIEW_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const
