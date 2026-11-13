import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, ApiHandlerError } from '@/lib/api-handler'

// 作品详情（公开，viewCount++）
export const GET = apiHandler<{ slug: string }>(
  async (_request: NextRequest, { params }) => {
    const { slug } = await params
    const prisma = await getPrisma()

    const work = await prisma.sharedWork.findUnique({
      where: { slug },
      include: { author: { select: { nickname: true, phone: true } } },
    })

    if (!work || work.status !== 'APPROVED') {
      throw new ApiHandlerError('作品不存在', 404)
    }

    await prisma.sharedWork.update({
      where: { id: work.id },
      data: { viewCount: { increment: 1 } },
    })

    return {
      id: work.id,
      slug: work.slug,
      title: work.title,
      description: work.description,
      type: work.type,
      coverUrl: work.coverUrl,
      nodes: work.nodes,
      connections: work.connections,
      likeCount: work.likeCount,
      viewCount: work.viewCount + 1,
      authorName: work.author.nickname || `用户${(work.author.phone || '未知').slice(-4)}`,
      createdAt: work.createdAt.toISOString(),
    }
  }
)
