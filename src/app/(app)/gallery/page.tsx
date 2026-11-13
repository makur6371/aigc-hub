import type { Metadata } from 'next'
import { PageContainer } from '@/components/layout/PageContainer'
import GalleryClient from '@/components/gallery/GalleryClient'
import { getPrisma } from '@/lib/prisma'
import { ORG } from '@/lib/site-content'
import { fmtAuthor } from '@/lib/gallery-display'

export const metadata: Metadata = {
  title: `作品广场 - ${ORG.name}`,
  description: `${ORG.name} 作品广场：展示用户创作的 AI 海报、插画、视频与多模态画布工作流，支持搜索、筛选与一键导入画布。`,
}

// 动态渲染：不依赖构建期预渲染（构建容器无可用 DB），每次请求服务端直出
// 由生产 nginx 对 gallery 做短期缓存兜底；featured 变化即时生效（改精选无需重部署）
export const dynamic = 'force-dynamic'

// 公开字段白名单：不取 authorId 等私密信息；作者只暴露 nickname / 末4位
// （实现收敛到 lib/gallery-display，列表与详情共用，台账 Q-108）

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '$$u003c') }}
    />
  )
}

/**
 * 作品广场：服务端壳（SEO head + 精选 JSON-LD）+ 客户端交互列表。
 *
 * 2026-09-29 合并：原 (public)/gallery 只读 SEO 版与 (app)/works 交互版读的是同一张
 * shared_works 表，两份实现导致改动要改两处、用户也困惑有两个入口。
 * 现在只保留本页 —— 公开可访问（利于 SEO），登录后具备搜索/筛选/点赞/导入画布能力。
 */
export default async function GalleryPage() {
  const prisma = await getPrisma()
  // 仅取精选作品用于服务端 JSON-LD（列表本身由客户端组件分页拉取）
  const works = await prisma.sharedWork.findMany({
    where: { status: 'APPROVED' },
    orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
    take: 36,
    select: {
      slug: true,
      title: true,
      description: true,
      type: true,
      coverUrl: true,
      featured: true,
      likeCount: true,
      viewCount: true,
      createdAt: true,
      author: { select: { nickname: true, phone: true } },
    },
  })

  const itemList = works.map((w, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'CreativeWork',
      name: w.title,
      url: `http://localhost:3000/gallery/${w.slug}`,
      image: w.coverUrl || '',
      creator: fmtAuthor(w.author),
      interactionStatistic: [
        { '@type': 'InteractionCounter', interactionType: 'http://schema.org/LikeAction', userInteractionCount: w.likeCount },
        { '@type': 'InteractionCounter', interactionType: 'http://schema.org/ViewAction', userInteractionCount: w.viewCount },
      ],
    },
  }))

  const galleryJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': 'http://localhost:3000/gallery#page',
        url: 'http://localhost:3000/gallery',
        name: `${ORG.name} 作品广场`,
        description: metadata.description,
        isPartOf: { '@id': 'http://localhost:3000/#org' },
        mainEntity: {
          '@type': 'ItemList',
          name: `${ORG.name} 精选作品`,
          itemListElement: itemList,
        },
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

  // ✅ 必须包 PageContainer：AppLayout 的 <Content> 是 overflow-hidden 的固定视口，
  // 页面得自带滚动容器，否则内容被裁掉且整页滚不动（2026-10-01 用 headless Chrome 实测确认：
  // <main> scrollHeight 3713 / clientHeight 900，document.scrollingElement 也无法滚动）。
  // 与 /prompts、个人中心等页统一：桌面导航避让由 AppLayout 的 md:pl-20 负责，页面滚动由这里负责。
  return (
    <PageContainer>
      <JsonLd data={galleryJsonLd} />

      <section className="mb-8">
        <p className="text-sm font-medium text-accent mb-3">精选作品</p>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-4">作品广场</h1>
        <p className="text-lg text-text-muted leading-relaxed max-w-3xl">
          用 {ORG.name} 创作的 AI 海报、插画、视频与多模态画布工作流。支持语义搜索、分类筛选，点击任意作品查看详情或一键导入画布。
        </p>
      </section>

      <GalleryClient />
    </PageContainer>
  )
}
