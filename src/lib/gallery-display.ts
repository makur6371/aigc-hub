/** 作品广场展示层共用格式化（原先 list 与 detail 两个页面各写一份，见台账 Q-108） */

/**
 * 公开字段白名单：不取 authorId 等私密信息；作者只暴露 nickname / 手机末4位
 */
export function fmtAuthor(a: { nickname: string | null; phone: string | null } | null): string {
  if (!a) return '匿名用户'
  return a.nickname || `用户${(a.phone || '未知').slice(-4)}`
}
