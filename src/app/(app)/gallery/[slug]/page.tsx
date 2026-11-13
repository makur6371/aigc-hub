import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPrisma } from '@/lib/prisma'
import { ORG } from '@/lib/site-content'
import { fmtAuthor } from '@/lib/gallery-display'
import { WorkImportButton } from '@/components/gallery/WorkImportButton'
import { PageContainer } from '@/components/layout/PageContainer'

export const dynamicParams = true
// 仅动态渲染已审核通过的作品详情，构建期/运行时未审核一律 404
export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  try {
    const prisma = await getPrisma()
    const work = await prisma.sharedWork.findUnique({
      where: { slug },
      select: { title: true, description: true, status: true, coverUrl: true, author: { select: { nickname: true, phone: true } } },
    })
    if (!work || work.status !== 'APPROVED') return { title: `作品未找到 - ${ORG.name}` }
    return {
      title: `${work.title} - ${ORG.name} 作品`,
      description: work.description?.slice(0, 120) || `${ORG.name} 平台精选 AI 创作作品。`,
      openGraph: work.coverUrl ? { images: [{ url: work.coverUrl }] } : undefined,
    }
  } catch {
    return { title: `作品未找到 - ${ORG.name}` }
  }
}

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}

export default async function GalleryWorkPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const prisma = await getPrisma()
  const work = await prisma.sharedWork.findUnique({
    where: { slug },
    select: {
      title: true,
      description: true,
      type: true,
      coverUrl: true,
      likeCount: true,
      viewCount: true,
      createdAt: true,
      status: true,
      // 「导入到画布」需要工作流快照（仅 workflow 类型作品有值）
      nodes: true,
      connections: true,
      author: { select: { nickname: true, phone: true } },
    },
  })

  if (!work || work.status !== 'APPROVED') notFound()

  // 浏览计数：原 (app)/works/[slug] 走 /api/works/[slug] 自增，该页删除后需在此补上，
  // 否则「浏览」永远是导入时的种子值（功能静默回归）。
  // 失败不阻断渲染 —— 计数是附带信息，不该让详情页挂掉。
  void prisma.sharedWork
    .update({ where: { slug }, data: { viewCount: { increment: 1 } } })
    .catch(() => {})

  const crJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CreativeWork',
        '@id': `http://localhost:3000/gallery/${slug}#work`,
        name: work.title,
        description: work.description || '',
        image: work.coverUrl || '',
        creator: fmtAuthor(work.author),
        datePublished: work.createdAt.toISOString(),
        isPartOf: { '@id': 'http://localhost:3000/gallery#page' },
        interactionStatistic: [
          { '@type': 'InteractionCounter', interactionType: 'http://schema.org/LikeAction', userInteractionCount: work.likeCount },
          { '@type': 'InteractionCounter', interactionType: 'http://schema.org/ViewAction', userInteractionCount: work.viewCount },
        ],
      },
      {
        '@type': 'Organization',
        '@id': 'http://localhost:3000/#org',
        name: ORG.name,
        url: ORG.url,
        logo: ORG.logo,
        description: ORG.tagline,
      },
    ],
  }

  const TYPE_LABEL: Record<string, string> = {
    workflow: '工作流',
    image: '图片',
    video: '视频',
  }

  // ✅ 与列表页同理：详情页也必须有自带滚动容器，否则被 <Content> 的 overflow-hidden 裁掉
  return (
    <PageContainer>
      <JsonLd data={crJsonLd} />

      <nav className="text-sm text-text-secondary mb-6" aria-label="面包屑">
        <Link href="/gallery" className="hover:text-accent">作品广场</Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">{work.title}</span>
      </nav>

      <article className="max-w-3xl">
        <header className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="px-2 py-0.5 rounded-md text-xs bg-accent-light text-accent">
              {TYPE_LABEL[work.type] || '作品'}
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">{work.title}</h1>
          <p className="text-sm text-text-secondary">
            作者 {fmtAuthor(work.author)} · 👁 {work.viewCount} 浏览 · ❤ {work.likeCount} 点赞
          </p>
        </header>

        {work.coverUrl && (
          <div className="mb-6 rounded-xl overflow-hidden border border-border">
            <img src={work.coverUrl} alt={work.title} className="w-full [aspect-ratio:auto]" loading="lazy" />
          </div>
        )}

        <section className="mb-8">
          <h2 className="text-lg font-semibold text-foreground mb-3">作品说明</h2>
          <p className="text-sm text-text-muted leading-relaxed whitespace-pre-line">
            {work.description || '该作品暂无说明。'}
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          {work.type === 'workflow' && Boolean(work.nodes && work.connections) && (
            <>
              <WorkImportButton
                title={work.title}
                nodes={work.nodes}
                connections={work.connections}
              />
              <span className="text-xs text-text-disabled">导入后可继续编辑和执行</span>
            </>
          )}
        </div>

        <div className="mt-8 text-sm">
          <Link href="/login" className="text-accent font-medium hover:underline">
            注册账号，用 {ORG.name} 创作你的作品 →
          </Link>
        </div>
      </article>
    </PageContainer>
  )
}
