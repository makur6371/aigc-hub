import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { saveAssetFile, detectAssetType, ASSET_MAX_SIZE, ASSET_QUOTA, expiresAtFor } from '@/lib/asset-store'
import { apiHandler, requireAuth, ApiHandlerError, success, parsePagination } from '@/lib/api-handler'
import { runMaintenance } from '@/lib/maintenance'

export const GET = apiHandler(async (request: NextRequest, { url }) => {
  const authUser = await requireAuth(request)
  // 惰性清理过期素材（节流 10 分钟），避免磁盘被临时素材占满
  void runMaintenance().catch(() => {})
  const prisma = await getPrisma()

  const { page, pageSize } = parsePagination(url, { pageSize: 48 })
  const type = url.searchParams.get('type')
  const source = url.searchParams.get('source')

  const where: Record<string, unknown> = { userId: authUser.userId }
  if (type) where.type = type
  if (source) where.source = source

  const [items, total] = await Promise.all([
    prisma.userAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.userAsset.count({ where }),
  ])

  return {
    items: items.map((a) => ({
      id: a.id,
      type: a.type,
      url: a.url,
      fileName: a.fileName,
      mime: a.mime,
      size: a.size,
      source: a.source,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  }
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const contentType = request.headers.get('content-type') || ''
  let buffer: Buffer
  let mime: string | undefined
  let fileName: string | undefined
  let source = 'upload'

  /**
   * 客户端可声明的来源白名单（都必须是**短 TTL** 的临时中转来源）。
   *
   * 为什么要有白名单：`expiresAtFor(source)` 决定素材是否过期，
   * 而 source 来自请求体 —— 不设限的话，客户端传 `'generated'`/`'upload'`
   * 就能把「喂给上游的一次性临时图」标成永久保留，绕过 TTL 策略长期占盘。
   * 只放行这些确实由前端在上传时声明的临时来源；其余一律按 `tool`（2h）处理。
   */
  const CLIENT_SOURCES = new Set(['tool', 'canvas', 'canvas-audio', 'tool-drag', 'workbench'])
  const normalizeSource = (s: unknown, fallback: string): string =>
    typeof s === 'string' && CLIENT_SOURCES.has(s) ? s : fallback

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      throw new ApiHandlerError('未收到文件', 400)
    }
    buffer = Buffer.from(await (file as File).arrayBuffer())
    mime = (file as File).type || undefined
    fileName = (file as File).name || undefined
    // 显式传了才用（且必须在白名单内）；没传保持默认 'upload'（用户主动上传，永久）
    source = normalizeSource(formData.get('source'), 'upload')
  } else {
    const body = await request.json().catch(() => null)
    if (!body || typeof body.data !== 'string') {
      throw new ApiHandlerError('未收到文件数据', 400)
    }
    const base64 = body.data.includes(',') ? body.data.split(',')[1] : body.data
    buffer = Buffer.from(base64, 'base64')
    mime = typeof body.mime === 'string' ? body.mime : undefined
    fileName = typeof body.fileName === 'string' ? body.fileName : undefined
    source = normalizeSource(body.source, 'upload')
  }

  if (buffer.byteLength > ASSET_MAX_SIZE) {
    throw new ApiHandlerError(`文件超过 ${ASSET_MAX_SIZE / 1024 / 1024}MB 限制`, 400)
  }

  // 配额检查：先清理过期素材（可能刚腾出空间），再校验总量与条数
  const prisma = await getPrisma()
  await runMaintenance().catch(() => {})
  const [quota, count] = await Promise.all([
    prisma.userAsset.aggregate({ where: { userId: authUser.userId }, _sum: { size: true } }),
    prisma.userAsset.count({ where: { userId: authUser.userId } }),
  ])
  const usedBytes = quota._sum.size ?? 0
  if (usedBytes + buffer.byteLength > ASSET_QUOTA.maxTotalBytes) {
    throw new ApiHandlerError(
      `素材空间不足：已用 ${Math.round(usedBytes / 1024 / 1024)}MB / 上限 ${ASSET_QUOTA.maxTotalBytes / 1024 / 1024}MB，请先清理素材库`,
      413,
    )
  }
  if (count >= ASSET_QUOTA.maxCount) {
    throw new ApiHandlerError(`素材数量已达上限（${ASSET_QUOTA.maxCount} 个），请先清理素材库`, 413)
  }

  const type = detectAssetType(mime, fileName)
  if (!type || !['image', 'video', 'audio'].includes(type)) {
    throw new ApiHandlerError('仅支持图片、视频、音频文件', 400)
  }

  const saved = await saveAssetFile(authUser.userId, buffer, { mime, fileName, type, source })

  const asset = await prisma.userAsset.create({
    data: {
      userId: authUser.userId,
      type: saved.type,
      url: saved.url,
      fileName: saved.fileName,
      mime: saved.mime,
      size: saved.size,
      source,
      // 按来源设过期时间：面板上传/拖入等临时素材会过期，用户主动上传永久保留
      expiresAt: expiresAtFor(source),
    },
  })

  return success(
    {
      id: asset.id,
      type: asset.type,
      url: asset.url,
      fileName: asset.fileName,
      mime: asset.mime,
      size: asset.size,
      source: asset.source,
      createdAt: asset.createdAt.toISOString(),
    },
    '上传成功'
  )
})
