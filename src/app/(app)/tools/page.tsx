import Link from 'next/link'
import { cookies } from 'next/headers'
import { getPrisma } from '@/lib/prisma'
import { CREATE_TOOL_SLUGS } from '@/lib/create-tools'
import { BASE_TOOL_CATEGORIES, VERTICAL_CATEGORIES } from '@/lib/constants/categories'
import { PageContainer } from '@/components/layout/PageContainer'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * 工具箱入口：展示可用工具目录，而不是重定向到某一个工具。
 *
 * 旧实现读 lastToolSlug 后 redirect 到默认工具，既多一次服务端跳转，
 * 又会在没有有效记忆时把用户送进「数字人对口型」这类垂直工具。
 * 目录只查一次数据库；继续使用上次工具放在最上面，其余按分类展示。
 */
export default async function ToolsEntryPage() {
  const jar = await cookies()
  const lastSlug = jar.get('lastToolSlug')?.value
  const prisma = await getPrisma()
  const tools = await prisma.tool.findMany({
    where: { status: 'APPROVED', slug: { notIn: CREATE_TOOL_SLUGS } },
    orderBy: [{ isOfficial: 'desc' }, { useCount: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      category: true,
      isOfficial: true,
      useCount: true,
    },
  })

  const last = lastSlug ? tools.find((tool) => tool.slug === lastSlug) ?? null : null
  const categoryOrder = [...BASE_TOOL_CATEGORIES, ...VERTICAL_CATEGORIES]
  const known = new Set<string>(categoryOrder)
  const groups: Array<{ category: string; items: typeof tools }> = categoryOrder
    .map((category) => ({ category, items: tools.filter((tool) => tool.category === category) }))
    .filter((group) => group.items.length > 0)
  const other = tools.filter((tool) => !tool.category || !known.has(tool.category))
  if (other.length > 0) groups.push({ category: '其他', items: other })

  return (
    <PageContainer maxWidth="1120px">
      <div className="space-y-7">
        <header className="px-1 pt-2">
          <p className="text-xs font-medium tracking-[0.2em] text-accent">TOOLBOX</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">工具箱</h1>
              <p className="mt-2 text-sm text-text-muted">选一个工具直接开始；进入后仍可在顶部切换其他工具。</p>
            </div>
            <span className="rounded-full bg-accent-light px-3 py-1 text-xs text-accent">{tools.length} 个可用工具</span>
          </div>
        </header>

        {last && (
          <Link
            href={`/tools/${last.slug}`}
            prefetch
            className="group flex items-center justify-between gap-4 rounded-[26px] border border-accent/20 bg-gradient-to-br from-accent-light/80 via-white/80 to-white/60 px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/35 hover:shadow-md"
          >
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-wide text-accent">继续使用上次工具</p>
              <p className="mt-1 truncate text-base font-semibold text-foreground">{last.name}</p>
              <p className="mt-1 truncate text-xs text-text-secondary">{last.category || '工具'} · 点击直接打开</p>
            </div>
            <span className="shrink-0 text-sm font-medium text-accent transition-transform group-hover:translate-x-0.5">继续 →</span>
          </Link>
        )}

        {groups.map((group) => (
          <section key={group.category} aria-label={group.category}>
            <div className="mb-3 flex items-baseline gap-3 px-1">
              <h2 className="text-sm font-semibold text-foreground">{group.category}</h2>
              <span className="text-[11px] text-text-disabled">{group.items.length} 个工具</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((tool) => (
                <Link
                  key={tool.id}
                  href={`/tools/${tool.slug}`}
                  prefetch
                  className="group flex min-h-[136px] flex-col rounded-[24px] border border-accent/10 bg-white/75 p-4 shadow-sm backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-accent-light px-2.5 py-0.5 text-[11px] text-accent">{tool.category || '工具'}</span>
                    {tool.isOfficial && <span className="text-[10px] font-medium text-warning-strong">官方</span>}
                  </div>
                  <h3 className="mt-3 text-[15px] font-semibold text-foreground">{tool.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">{tool.description || '打开即可使用'}</p>
                  <div className="mt-auto flex items-center justify-between pt-3 text-[11px] text-text-disabled">
                    <span>已使用 {tool.useCount} 次</span>
                    <span className="font-medium text-accent transition-transform group-hover:translate-x-0.5">打开 →</span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}

        {tools.length === 0 && (
          <div className="rounded-[26px] border border-dashed border-accent/20 bg-white/60 px-6 py-16 text-center text-sm text-text-muted">
            暂无可用工具，请稍后再试。
          </div>
        )}
      </div>
    </PageContainer>
  )
}
