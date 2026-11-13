/**
 * 业务「日」的唯一来源。
 *
 * 为什么必须有一个文件：免费额度（lib/free-quota.ts）与团队每日额度
 * （lib/billing/team.ts）都按「本地日」分桶、跨天自动归零 —— 同一个概念。
 * 此前两处各写了一份 YYYY-MM-DD 计算，口径一致时看不出问题，一旦有人只改一处
 * （例如改成 UTC 分桶）就会出现「扣费侧已归零、展示侧还显示昨天用量」的分叉。
 *
 * 时区：生产 docker-compose 显式设 `TZ=Asia/Shanghai`，即业务按北京时间 0 点重置。
 * 本地日 = 进程时区日，不要改用 toISOString()（那是 UTC，会在北京 00:00-08:00 差一天）。
 */

/** 本地日分桶键 YYYY-MM-DD（按进程时区，生产 = Asia/Shanghai）。 */
export function localDayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 判断分桶键是否属于「今天」。
 *
 * 读接口必须用它，**不能**写成 `key ? value : 0`：分桶键只在发生消费时才写入，
 * 昨天消费过的成员今天尚未消费时 key 仍是昨天 —— 用真值判断会把昨天的用量
 * 当成今天展示，老板/管理员看到的数字与成员真实可用额度不一致。
 */
export function isTodayKey(day: string | null | undefined, now: Date = new Date()): boolean {
  return day === localDayKey(now)
}
