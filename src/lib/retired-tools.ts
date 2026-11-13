export type RetiredToolMigration = {
  /** 已下架工具的 slug（用户访问的路径） */
  slug: string
  /** 承接它的新工具 slug */
  to: string
  /** 给用户看的一句话：为什么变了、现在用什么 */
  note: string
  /**
   * 承接方不是 /tools/<slug> 而是独立工作区（如 /create/video）时给出完整路径；
   * 有 href 时前端跳 href，没有才拼 /tools/<to>。
   */
  href?: string
}

export const RETIRED_TOOL_MIGRATIONS: RetiredToolMigration[] = []

export function findRetiredMigration(slug: string) {
  return RETIRED_TOOL_MIGRATIONS.find((entry) => entry.slug === slug)
}
