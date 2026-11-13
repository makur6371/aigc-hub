// 基础生图工具：文生图 / 图生图 / 上传参考图 / 查看产出。
//
// ===== 为什么是这三个 + 一个查询 =====
// 用户的原话：「放大、抠图、去水印那些根本不用。它本质上还是调用生图接口，
// 图生图加一点提示词指令。咱只需要放开文生图、图生图就行了」。
// 所以：
//   - 高清放大/抠图/去水印/翻译 **不单独建工具** —— 它们就是 edit_image + 一段提示词，
//     单独暴露等于把「提示词」当成 API 表面，Agent 反而要先记 4 个工具名。
//   - 只放开两个真正不同的链路：generate_image（文生图）、edit_image（图生图）。
//   - 加 upload_image：MCP 的既有设计**拒绝 base64 入参**（见 sanitize.checkWorkflowSize），
//     但 Agent 手上只有本地文件，没有 URL —— 这条链原本是断的（只能让用户自己去网页传）。
//     这个工具补上「把图交给我们、换回公网 URL」这一环。
//   - 加 list_images：让 Agent 能查看自己生成过什么、花了多少积分。
//     画布那条链有 get_run 能看 costPoints，基础生图没有对应能力就成了盲盒。
//
// ===== 复用（不另造）=====
//   - 计费/退款/免费额度 → chargeRun（与 /api/image/generate 同一实现）
//   - 落盘/配额/TTL      → saveAssetFile + ASSET_QUOTA + expiresAtFor（与 /api/assets 同一实现）
//   - 公网化             → publicizeReferenceImages（全站唯一入口）
//   - 产出归档           → imageGenerationRecord（与网页端"我的图片"同一张表）

import { getPrisma } from '@/lib/prisma'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { generateImage } from '@/lib/media-provider'
import { invokeImage } from '@/lib/provider-invoker'
import {
  saveAssetFile, detectAssetType, ASSET_MAX_SIZE, ASSET_QUOTA, expiresAtFor, isOwnAssetUrl,
} from '@/lib/asset-store'
import { publicizeReferenceImages } from '@/lib/upstream-image'
import { structured, error, type ToolResult } from './types'

/** 生成记录的保留期（与 /api/image/generate 口径一致） */
const RECORD_EXPIRY_DAYS = 30

/**
 * 上传参考图 → 公网 URL。
 *
 * 入参只收 base64（data URL 或裸 base64）。**出参只回 URL，绝不回 base64** ——
 * 这是 sanitize.ts 既有决策的延续：base64 会把 Agent 上下文撑爆，
 * 而 URL 只有几十字节。
 */
export async function uploadImage(
  userId: string,
  args: { data: string; fileName?: string; mime?: string },
): Promise<ToolResult> {
  const raw = typeof args.data === 'string' ? args.data.trim() : ''
  if (!raw) return error('缺少图片数据：请把图片内容以 base64 放进 data 字段')

  // 兼容两种写法：完整 data URL（data:image/png;base64,xxx）或裸 base64
  let mime = typeof args.mime === 'string' ? args.mime : undefined
  let base64 = raw
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(raw)
  if (m) {
    mime = mime || m[1]
    base64 = m[2]
  }

  // 体积预检放在解码之前：超大 base64 先拒掉，避免白白解码出一个大 Buffer 占内存
  // （base64 膨胀约 33%，用长度反推原始大小）
  const approxBytes = Math.floor(base64.length * 0.75)
  if (approxBytes > ASSET_MAX_SIZE) {
    return error(
      `图片过大：约 ${Math.round(approxBytes / 1024 / 1024)}MB，上限 ${ASSET_MAX_SIZE / 1024 / 1024}MB。请压缩后再传。`,
    )
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return error('图片数据不是合法的 base64')
  }
  if (buffer.byteLength === 0) return error('图片数据为空（base64 解码后没有内容）')
  if (buffer.byteLength > ASSET_MAX_SIZE) {
    return error(`图片过大：${Math.round(buffer.byteLength / 1024 / 1024)}MB，上限 ${ASSET_MAX_SIZE / 1024 / 1024}MB。`)
  }

  const fileName = typeof args.fileName === 'string' ? args.fileName : undefined
  const type = detectAssetType(mime, fileName)
  if (type !== 'image') {
    return error(`仅支持图片。识别到的类型：${type ?? '未知'}（mime: ${mime ?? '未提供'}）`)
  }

  const prisma = await getPrisma()

  // 配额检查：与 /api/assets 同一套口径与文案，避免两条路径限额不一致
  const [quota, count] = await Promise.all([
    prisma.userAsset.aggregate({ where: { userId }, _sum: { size: true } }),
    prisma.userAsset.count({ where: { userId } }),
  ])
  const usedBytes = quota._sum.size ?? 0
  if (usedBytes + buffer.byteLength > ASSET_QUOTA.maxTotalBytes) {
    return error(
      `素材空间不足：已用 ${Math.round(usedBytes / 1024 / 1024)}MB / 上限 ${ASSET_QUOTA.maxTotalBytes / 1024 / 1024}MB，请先清理素材库`,
    )
  }
  if (count >= ASSET_QUOTA.maxCount) {
    return error(`素材数量已达上限（${ASSET_QUOTA.maxCount} 个），请先清理素材库`)
  }

  // source='tool'：临时中转素材，2 小时 TTL 由既有清理任务回收。
  // Agent 传的图只是"给上游拉一次"，不该永久占盘 —— 与面板上传同一档。
  const source = 'tool'
  const saved = await saveAssetFile(userId, buffer, { mime, fileName, type, source })

  await prisma.userAsset.create({
    data: {
      userId, type: saved.type, url: saved.url, fileName: saved.fileName,
      mime: saved.mime, size: saved.size, source,
      expiresAt: expiresAtFor(source),
    },
  }).catch(() => { /* 登记失败不影响本次使用 */ })

  // 落盘后立刻公网化：Agent 拿到的必须是上游能 fetch 的绝对地址
  const [publicUrl] = await publicizeReferenceImages([saved.url], userId)

  return structured(
    `图片已就绪，公网地址：${publicUrl}\n（临时素材，2 小时后自动清理；长期保存请下载）\n可直接把它作为 edit_image 的 referenceImages 使用。`,
    { url: publicUrl, expiresInHours: 2 },
  )
}

/**
 * 文生图。
 *
 * 与 /api/image/generate 同一链路：chargeRun（预扣+失败退款）→ generateImage → 写记录。
 */
export async function generateImageTool(
  userId: string,
  args: { prompt: string; modelId?: string; width?: number; height?: number; count?: number },
): Promise<ToolResult> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) return error('缺少 prompt：请描述要生成什么画面')

  const count = Math.min(Math.max(1, Math.floor(Number(args.count) || 1)), 4)

  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId, modelType: 'IMAGE',
      modelId: typeof args.modelId === 'string' ? args.modelId : undefined,
      width: typeof args.width === 'number' ? args.width : undefined,
      height: typeof args.height === 'number' ? args.height : undefined,
      count,
      source: 'agent',
    })
  } catch (err) {
    if (err instanceof ChargeRunError) return error(err.message)
    throw err
  }

  const actualWidth = run.imageSize?.width ?? args.width
  const actualHeight = run.imageSize?.height ?? args.height
  const requestDetail = { prompt, width: actualWidth, height: actualHeight, modelId: run.model.id, count }
  const expiresAt = new Date(Date.now() + RECORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
  const prisma = await getPrisma()

  const urls: string[] = []
  try {
    for (let i = 0; i < count; i++) {
      const result = await run.execute(() => generateImage({
        baseUrl: run.model.baseUrl, apiKey: run.model.apiKey, modelName: run.model.modelName,
        prompt, userId,
        width: actualWidth,
        height: actualHeight,
        adapterId: run.model.adapterId,
        configJson: run.model.configJson as Record<string, unknown> | null,
        modelMetadata: (run.model.metadata as Record<string, unknown> | null) ?? null,
      }))
      if (!result.imageUrl) throw new Error('上游未返回图片')
      urls.push(result.imageUrl)
    }
  } catch (err) {
    const message = await run.fail(err, { nodeLabel: 'MCP 文生图', request: requestDetail })
    return error(message)
  }

  // 归档到"我的图片"（与网页端同一个地方 —— 否则用户在外部生的图回站内找不到）
  for (const url of urls) {
    await prisma.imageGenerationRecord.create({
      data: {
        userId, modelId: run.model.id, prompt,
        width: actualWidth ?? null,
        height: actualHeight ?? null,
        imageUrl: url, costPoints: run.cost.points, status: 'SUCCESS',
        runId: run.runId,
        expiresAt,
      },
    }).catch(() => {})
    if (isOwnAssetUrl(url)) {
      await prisma.userAsset.create({
        data: {
          userId, type: 'image', url, fileName: prompt.slice(0, 50) || '生成图片',
          mime: 'image/*', source: 'generated',
        },
      }).catch(() => {})
    }
  }

  await run.settle({ nodeLabel: 'MCP 文生图', request: requestDetail, response: { imageUrls: urls } })

  return structured(
    `已生成 ${urls.length} 张图（模型：${run.model.name}，消耗 ${run.cost.points} 积分）：\n${urls.join('\n')}`,
    { imageUrls: urls, model: run.model.name, costPoints: run.cost.points },
  )
}

/**
 * 图生图。
 *
 * referenceImages 接受公网 URL 或站内相对路径 —— 后者会被 publicizeReferenceImages
 * 转成绝对地址（含存活检查）。上传图请先用 upload_image 换成 URL。
 * 高清放大/抠图/去水印/翻译都走这里，靠 prompt 表达（不单独建工具）。
 */
export async function editImageTool(
  userId: string,
  args: { prompt: string; referenceImages: string[]; modelId?: string; width?: number; height?: number },
): Promise<ToolResult> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) return error('缺少 prompt：请描述要把参考图改成什么样')

  const refs = Array.isArray(args.referenceImages)
    ? args.referenceImages.filter((u): u is string => typeof u === 'string' && !!u.trim())
    : []
  if (refs.length === 0) {
    return error('缺少 referenceImages：图生图至少需要一张参考图。先用 upload_image 把本地图片换成 URL。')
  }
  if (refs.length > 6) return error(`参考图最多 6 张，收到 ${refs.length} 张`)

  // 公网化：站内相对路径 → 绝对地址；素材已过期会抛错（给的是可读中文原因）
  let publicRefs: string[]
  try {
    publicRefs = await publicizeReferenceImages(refs, userId)
  } catch (err) {
    return error(err instanceof Error ? err.message : '参考图处理失败')
  }

  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId, modelType: 'IMAGE',
      modelId: typeof args.modelId === 'string' ? args.modelId : undefined,
      width: typeof args.width === 'number' ? args.width : undefined,
      height: typeof args.height === 'number' ? args.height : undefined,
      source: 'agent',
    })
  } catch (err) {
    if (err instanceof ChargeRunError) return error(err.message)
    throw err
  }

  const actualWidth = run.imageSize?.width ?? args.width
  const actualHeight = run.imageSize?.height ?? args.height
  const requestDetail = {
    prompt, modelId: run.model.id, width: actualWidth, height: actualHeight,
    referenceImages: publicRefs.length,
  }
  const expiresAt = new Date(Date.now() + RECORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
  const prisma = await getPrisma()

  let imageUrl: string
  try {
    const result = await run.execute(() => invokeImage(
      {
        baseUrl: run.model.baseUrl, apiKey: run.model.apiKey,
        adapterId: run.model.adapterId ?? undefined,
        configJson: run.model.configJson ?? undefined,
        metadata: run.model.metadata,
      },
      run.model.modelName,
      {
        prompt, referenceImages: publicRefs,
        width: actualWidth,
        height: actualHeight,
      },
      userId,
    ))
    if (!result.imageUrl) throw new Error('上游未返回图像')
    imageUrl = result.imageUrl
  } catch (err) {
    const message = await run.fail(err, { nodeLabel: 'MCP 图生图', request: requestDetail })
    return error(message)
  }

  await prisma.imageGenerationRecord.create({
    data: {
      userId, modelId: run.model.id, prompt,
        width: actualWidth ?? null,
        height: actualHeight ?? null,
      imageUrl, costPoints: run.cost.points, status: 'SUCCESS',
      runId: run.runId,
      expiresAt,
    },
  }).catch(() => {})
  if (isOwnAssetUrl(imageUrl)) {
    await prisma.userAsset.create({
      data: {
        userId, type: 'image', url: imageUrl, fileName: prompt.slice(0, 50) || '图生图',
        mime: 'image/*', source: 'generated',
      },
    }).catch(() => {})
  }

  await run.settle({ nodeLabel: 'MCP 图生图', request: requestDetail, response: { imageUrl } })

  return structured(
    `已完成图生图（模型：${run.model.name}，参考图 ${publicRefs.length} 张，消耗 ${run.cost.points} 积分）：\n${imageUrl}`,
    { imageUrl, model: run.model.name, costPoints: run.cost.points, referenceCount: publicRefs.length },
  )
}

/**
 * 查看生成记录 —— 让 Agent 能看到"我生成了什么、花了多少"。
 * 画布链有 get_run 可查 costPoints，基础生图没有对应能力就成了盲盒。
 */
export async function listImages(
  userId: string,
  args: { limit?: number; status?: string },
): Promise<ToolResult> {
  const prisma = await getPrisma()
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 10)), 50)
  const where = {
    userId,
    ...(args.status === 'success' ? { status: 'SUCCESS' } : {}),
    ...(args.status === 'failed' ? { status: 'FAILED' } : {}),
  }

  const rows = await prisma.imageGenerationRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, prompt: true, status: true, imageUrl: true,
      costPoints: true, errorMessage: true, createdAt: true, expiresAt: true, modelId: true,
    },
  })

  const now = Date.now()
  const items = rows.map((r) => ({
    id: r.id,
    prompt: r.prompt.slice(0, 120),
    status: r.status,
    imageUrl: r.status === 'SUCCESS' ? r.imageUrl : null,
    costPoints: r.costPoints,
    error: r.status === 'FAILED' ? r.errorMessage : null,
    createdAt: r.createdAt.toISOString(),
    // 上游链接会过期：过期后 URL 仍在记录里但已打不开，明确标出来免得 Agent 当成可用图
    expired: r.expiresAt ? r.expiresAt.getTime() < now : false,
  }))

  if (items.length === 0) {
    return structured('还没有生成记录。', { items: [], count: 0 })
  }
  const lines = items.map((i) =>
    `- [${i.status}] ${i.prompt}${i.expired ? '（链接已过期）' : ''}${i.imageUrl ? `\n  ${i.imageUrl}` : ''}${i.error ? `\n  失败原因：${i.error}` : ''}`,
  )
  return structured(
    `最近 ${items.length} 条生成记录（消耗 ${items.reduce((s, i) => s + (i.costPoints || 0), 0)} 积分）：\n${lines.join('\n')}`,
    { items, count: items.length },
  )
}
