import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { rm } from 'fs/promises'
import { fileOfAssetUrl } from '@/lib/asset-store'

export const DELETE = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    const authUser = await requireAuth(request)
    const { id } = await params
    const prisma = await getPrisma()

    const existing = await prisma.userAsset.findFirst({
      where: { id, userId: authUser.userId },
    })
    if (!existing) {
      throw new ApiHandlerError('素材不存在', 404)
    }

    // 先删磁盘文件再删库记录：只删库会让文件留到 24h 孤儿清理才回收，
    // 期间用户已删素材仍占磁盘、且配额（按库计）已释放，造成「删完又能传、盘却更满」。
    // 外链（非站内）解析为 null，跳过。文件删除失败不阻断删记录（最多留孤儿由兜底清理）。
    const abs = fileOfAssetUrl(existing.url)
    if (abs) await rm(abs, { force: true }).catch(() => {})

    await prisma.userAsset.delete({ where: { id } })
    return success(null, '已删除')
  }
)
