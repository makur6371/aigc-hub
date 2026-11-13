import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { saveAssetFile, detectAssetType, ASSET_MAX_SIZE, ASSET_QUOTA, expiresAtFor } from '@/lib/asset-store'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { runMaintenance } from '@/lib/maintenance'
import { checkUrlSafe } from '@/lib/ssrf-guard'

// 外链图片转存为本站素材。
//
// 用途：**用户主动保存**（把上游临时链接的成果图存进自己的素材库长期保留）。
// 注意：成果区**默认不再自动调它** —— 生成结果直接用上游 URL 展示，
// 过期就过期，前端提示用户尽快下载（见 useToolRunStore 的说明）。
// 这里保留是为了「保存到我的素材」这类主动动作。
export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const body = await request.json().catch(() => null)
  const url = typeof body?.url === 'string' ? body.url : ''
  if (!/^https?:\/\//i.test(url)) {
    throw new ApiHandlerError('仅支持 http(s) 外链', 400)
  }
  // 防 SSRF：与 /api/asset-proxy、rehostExternalAsset 同口径 —— 用户给的外链
  // 不能让服务器去请求内网/云元数据地址（169.254.169.254 等）。
  const safe = await checkUrlSafe(url)
  if (!safe.ok) throw new ApiHandlerError(safe.reason || '禁止访问该地址', 403)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  let buffer: Buffer
  let mime: string | undefined
  try {
    // redirect: 'manual' —— 不自动跟随跳转，避免「合法公网 URL → 302 到内网」绕过上面的校验。
    // 跳转视为拉取失败（转存场景下用户给的是直链，不应有跳转）。
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 AIGC Hub/1.0' } })
    if (res.status >= 300 && res.status < 400) throw new ApiHandlerError('外链发生跳转，请提供直链地址', 400)
    if (!res.ok) throw new ApiHandlerError(`外链拉取失败（${res.status}）`, 400)
    const type = res.headers.get('content-type') || ''
    if (!type.startsWith('image/')) throw new ApiHandlerError('外链不是图片', 400)
    mime = type.split(';')[0]
    buffer = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    if (e instanceof ApiHandlerError) throw e
    throw new ApiHandlerError('外链拉取失败', 400)
  } finally {
    clearTimeout(timer)
  }

  if (buffer.byteLength === 0) throw new ApiHandlerError('外链内容为空', 400)
  if (buffer.byteLength > ASSET_MAX_SIZE) {
    throw new ApiHandlerError(`文件超过 ${ASSET_MAX_SIZE / 1024 / 1024}MB 限制`, 400)
  }

  const type = detectAssetType(mime, url)
  if (type !== 'image') throw new ApiHandlerError('外链不是可识别的图片', 400)

  // 配额检查：转存同样占盘，先清过期再校验
  const prisma = await getPrisma()
  await runMaintenance().catch(() => {})
  const [quota, count] = await Promise.all([
    prisma.userAsset.aggregate({ where: { userId: authUser.userId }, _sum: { size: true } }),
    prisma.userAsset.count({ where: { userId: authUser.userId } }),
  ])
  const usedBytes = quota._sum.size ?? 0
  if (usedBytes + buffer.byteLength > ASSET_QUOTA.maxTotalBytes) {
    throw new ApiHandlerError('素材空间不足，请先清理素材库', 413)
  }
  if (count >= ASSET_QUOTA.maxCount) {
    throw new ApiHandlerError(`素材数量已达上限（${ASSET_QUOTA.maxCount} 个），请先清理素材库`, 413)
  }

  // 用户主动保存 → 永久保留（source='upload' 语义），与「临时中转」区分开
  const saved = await saveAssetFile(authUser.userId, buffer, { mime, fileName: url.split('/').pop()?.split('?')[0] || 'rehost', type, source: 'upload' })
  const asset = await prisma.userAsset.create({
    data: {
      userId: authUser.userId,
      type: saved.type,
      url: saved.url,
      fileName: saved.fileName,
      mime: saved.mime,
      size: saved.size,
      source: 'upload',
      // 用户主动保存的素材：永久保留（expiresAtFor 对 'upload' 返回 null）
      expiresAt: expiresAtFor('upload'),
    },
  })
  return success({ url: saved.url, id: asset.id }, '已转存')
})
