import sharp from 'sharp'
import { readFile, mkdir, writeFile } from 'fs/promises'
import { resolve, join } from 'path'
import { randomUUID } from 'crypto'
import { ASSET_DIR, ASSET_URL_PREFIX, sniffImageMime } from './asset-store'
import { checkUrlSafe } from './ssrf-guard'
import { gridFrameCount, isGifImageUrl, normalizeGrid } from './nine-grid-loop'

interface CropRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 按多个裁切区域裁切图片，返回裁切后图片的 URL 数组。
 * 原图支持 http(s) URL / 站内 /generated/ 素材 / data:base64。裁切结果落盘到素材目录。
 */
export async function cropImageRegions(
  imageUrl: string,
  regions: CropRegion[],
  userId: string
): Promise<string[]> {
  if (!imageUrl) throw new Error('裁切缺少原图')
  if (!regions || regions.length === 0) throw new Error('裁切缺少区域，请先在工作台框选/选择格子')

  // 获取原图 Buffer
  let buffer: Buffer
  if (imageUrl.startsWith('data:')) {
    const b64 = imageUrl.split(',')[1] || ''
    buffer = Buffer.from(b64, 'base64')
  } else if (imageUrl.startsWith('/generated/') || imageUrl.startsWith('/api/asset/')) {
    // 站内素材直读本地文件（Node 侧 fetch 相对路径必然失败）
    const rel = imageUrl.slice(imageUrl.startsWith('/api/asset/') ? '/api/asset/'.length : '/generated/'.length)
    buffer = Buffer.from(await readFile(join(ASSET_DIR, rel)))
  } else {
    // 防 SSRF：这里拉的是用户/上游给的图片地址，不能盲信（可指向内网/云元数据）
    const safe = await checkUrlSafe(imageUrl)
    if (!safe.ok) throw new Error(safe.reason || '图片地址不可访问')
    const resp = await fetch(imageUrl)
    if (!resp.ok) throw new Error(`获取原图失败: ${resp.status}`)
    const ab = await resp.arrayBuffer()
    buffer = Buffer.from(ab)
  }

  const dir = resolve(ASSET_DIR, userId)
  await mkdir(dir, { recursive: true })

  // 获取原图尺寸用于边界校验
  const meta = await sharp(buffer).metadata()
  const imgW = meta.width || 0
  const imgH = meta.height || 0

  const urls: string[] = []
  for (const region of regions) {
    // 边界校验 + clamp
    const left = Math.max(0, Math.round(region.x))
    const top = Math.max(0, Math.round(region.y))
    let width = Math.round(region.width)
    let height = Math.round(region.height)
    if (imgW > 0 && left + width > imgW) width = imgW - left
    if (imgH > 0 && top + height > imgH) height = imgH - top
    if (width <= 0 || height <= 0) continue  // 跳过无效区域

    const out = await sharp(buffer)
      .extract({ left, top, width, height })
      .png()
      .toBuffer()

    const fileName = `${randomUUID()}.png`
    await writeFile(resolve(dir, fileName), out)
    urls.push(`${ASSET_URL_PREFIX}/${userId}/${fileName}`)
  }

  if (urls.length === 0) throw new Error('裁切后无有效图片，请检查框选区域')
  return urls
}

/**
 * 按宫格切分图片（3×3 / 2×2），返回全部格子按「从左到右、从上到下」编号的 URL 数组。
 * 用于「先整图切九格 → 各格单独处理」的工作流（如九宫格高清放大），
 * 无需作者在工作台手工框选，执行时按 mode 自动均分。
 */
export async function cropImageGrid(
  imageUrl: string,
  grid: 2 | 3,
  userId: string,
): Promise<string[]> {
  if (!imageUrl) throw new Error('裁切缺少原图')
  const buffer = await readSourceBuffer(imageUrl)
  const meta = await sharp(buffer).metadata()
  const imgW = meta.width || 0
  const imgH = meta.height || 0
  if (imgW <= 0 || imgH <= 0) throw new Error('无法读取原图尺寸')

  // 均分；最后一行/列吃掉取整余数，保证不丢像素
  const cellW = Math.floor(imgW / grid)
  const cellH = Math.floor(imgH / grid)
  const dir = resolve(ASSET_DIR, userId)
  await mkdir(dir, { recursive: true })

  const urls: string[] = []
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const left = col * cellW
      const top = row * cellH
      const width = col === grid - 1 ? imgW - left : cellW
      const height = row === grid - 1 ? imgH - top : cellH
      if (width <= 0 || height <= 0) continue
      const out = await sharp(buffer).extract({ left, top, width, height }).png().toBuffer()
      const fileName = `${randomUUID()}.png`
      await writeFile(resolve(dir, fileName), out)
      urls.push(`${ASSET_URL_PREFIX}/${userId}/${fileName}`)
    }
  }
  return urls
}

export interface GridGifOptions {
  /** 3 = 3×3 九帧；4 = 4×4 十六帧；默认 3 */
  grid?: unknown
  /** 每帧间隔（毫秒），默认 150 */
  delayMs?: number
  /** normal=正序循环；pingpong=往返乒乓（1→9→1） */
  mode?: string
  /** 帧选择：1-9、1,3,5、1-4,9；留空=全部 9 帧 */
  frames?: string | number[]
  /** 每格四边裁掉的百分比（去掉九宫格分隔线），0-10，默认 1 */
  trimPercent?: number
  /** 单帧最长边上限（像素），默认 512 */
  maxSize?: number
  /** GIF 背景色；传 transparent 保留透明 */
  background?: string
}

export interface GridGifResult {
  gif: Buffer
  /** 归一化后的原图（供「调速」重新合成时落一份站内稳定地址） */
  sourceImage: Buffer
  sourceMime: string
  /** 选中的帧（去重、按选择顺序） */
  frames: Buffer[]
  width: number
  height: number
  delayMs: number
  /** 最终 GIF 的帧数（乒乓模式会包含回程帧） */
  frameCount: number
  selectedFrames: number[]
}

/**
 * 解析「九帧选择」文本。
 *
 * 支持：
 *   1-9 / 1~9 / 1到9
 *   1,3,5,7,9
 *   1-4,9
 * 留空、all、全部、* 都视为 1..total。
 * 越界值忽略，重复值只保留第一次出现的位置 —— 用户写的顺序就是播放顺序。
 */
export function parseGridFrameSelection(raw: string | number[] | undefined, total = 9): number[] {
  if (Array.isArray(raw)) {
    const out: number[] = []
    for (const item of raw) {
      const n = Math.round(Number(item))
      if (Number.isInteger(n) && n >= 1 && n <= total && !out.includes(n)) out.push(n)
    }
    return out
  }

  const text = String(raw ?? '').trim()
  if (!text || /^(all|全部|\*)$/i.test(text)) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const out: number[] = []
  const add = (n: number) => {
    if (Number.isInteger(n) && n >= 1 && n <= total && !out.includes(n)) out.push(n)
  }
  for (const part of text.split(/[,，、\s]+/)) {
    if (!part) continue
    const range = part.match(/^(\d+)\s*(?:-|~|～|到)\s*(\d+)$/)
    if (range) {
      let start = Number(range[1])
      let end = Number(range[2])
      if (start > end) [start, end] = [end, start]
      for (let n = start; n <= end; n++) add(n)
    } else {
      add(Number(part.replace(/[^\d]/g, '')))
    }
  }
  return out
}

/**
 * 九宫格大图 → 循环 GIF。
 *
 * 服务端直接用 sharp 的 `join: { animated: true }` + cgif 编码，
 * 不引入浏览器端 gifshot，也不需要把 9 张帧传给前端再合成。
 *
 * 两个关键细节：
 *   1. `keepDuplicateFrames: true` —— 无缝循环的第 9 帧通常与第 1 帧相同，
 *      默认会被合并成 1 帧，导致播放节奏少一拍；
 *   2. 裁格线（trimPercent）—— 生成图常带极细分隔线，等分切会把线留在帧边缘，
 *      每格四边各裁掉一点才能真正无缝。
 */
export async function createGridGif(
  imageUrl: string,
  opts: GridGifOptions = {},
): Promise<GridGifResult> {
  if (!imageUrl) throw new Error('九宫格转GIF缺少原图')

  // 先按 EXIF 方向摆正，避免手机拍的网格图被横过来切
  const normalized = await sharp(await readSourceBuffer(imageUrl)).rotate().toBuffer()
  const meta = await sharp(normalized).metadata()
  const imgW = meta.width || 0
  const imgH = meta.height || 0
  if (imgW <= 0 || imgH <= 0) throw new Error('无法读取九宫格原图尺寸')

  const grid = normalizeGrid(opts.grid)
  const total = gridFrameCount(grid)
  const selection = parseGridFrameSelection(opts.frames, total)
  if (selection.length === 0) {
    throw new Error(`帧选择没有有效帧：请填 1-${total}、1,3,5，或 ${grid}×${grid} 的行列区间`)
  }

  const cellW = Math.floor(imgW / grid)
  const cellH = Math.floor(imgH / grid)
  const trimPct = Math.min(10, Math.max(0, Number(opts.trimPercent) || 0))

  const boundsOf = (frameNo: number) => {
    const row = Math.floor((frameNo - 1) / grid)
    const col = (frameNo - 1) % grid
    const left0 = col * cellW
    const top0 = row * cellH
    const width0 = col === grid - 1 ? imgW - left0 : cellW
    const height0 = row === grid - 1 ? imgH - top0 : cellH
    const trimX = Math.min(Math.floor((width0 * trimPct) / 100), Math.max(0, Math.floor(width0 / 2) - 1))
    const trimY = Math.min(Math.floor((height0 * trimPct) / 100), Math.max(0, Math.floor(height0 / 2) - 1))
    return {
      left: left0 + trimX,
      top: top0 + trimY,
      width: Math.max(1, width0 - trimX * 2),
      height: Math.max(1, height0 - trimY * 2),
    }
  }

  const firstBounds = boundsOf(selection[0])
  const maxSize = Math.min(1024, Math.max(64, Math.round(Number(opts.maxSize) || 512)))
  const scale = Math.min(maxSize / firstBounds.width, maxSize / firstBounds.height, 1)
  const targetW = Math.max(1, Math.round(firstBounds.width * scale))
  const targetH = Math.max(1, Math.round(firstBounds.height * scale))

  const bgRaw = String(opts.background ?? '#ffffff').trim()
  const transparent = !bgRaw || /^(transparent|none|透明)$/i.test(bgRaw)
  const background = bgRaw || '#ffffff'

  const frameBuffers: Buffer[] = []
  for (const frameNo of selection) {
    const b = boundsOf(frameNo)
    let pipeline = sharp(normalized)
      .extract({ left: b.left, top: b.top, width: b.width, height: b.height })
      .resize(targetW, targetH, { fit: 'fill' })
    if (!transparent) pipeline = pipeline.flatten({ background })
    frameBuffers.push(await pipeline.png().toBuffer())
  }

  // 与前端工具一致的序列算法：正序；乒乓则追加「去掉首尾后的回程」
  const modeRaw = String(opts.mode ?? 'normal').trim().toLowerCase()
  const pingpong = ['pingpong', 'ping-pong', '往返乒乓', '乒乓', '往返'].includes(modeRaw)
  const order = selection.map((_, index) => index)
  const sequence = pingpong && order.length > 2
    ? [...order, ...order.slice(1, -1).reverse()]
    : order
  const sequenceBuffers = sequence.map((index) => frameBuffers[index])

  const delayMs = Math.min(5000, Math.max(20, Math.round(Number(opts.delayMs) || 150)))
  const gif = sequenceBuffers.length === 1
    ? await sharp(sequenceBuffers[0]).gif({ loop: 0, delay: delayMs, effort: 7, colours: 256 }).toBuffer()
    : await sharp(sequenceBuffers, { join: { animated: true } })
      .gif({
        loop: 0,
        delay: Array(sequenceBuffers.length).fill(delayMs),
        // 无缝循环的首尾帧往往完全相同，不能合并掉
        keepDuplicateFrames: true,
        effort: 7,
        colours: 256,
      })
      .toBuffer()

  return {
    gif,
    sourceImage: normalized,
    sourceMime: meta.format === 'jpeg' ? 'image/jpeg' : meta.format === 'webp' ? 'image/webp' : 'image/png',
    frames: frameBuffers,
    width: targetW,
    height: targetH,
    delayMs,
    frameCount: sequenceBuffers.length,
    selectedFrames: selection,
  }
}

/**
 * 判断「输入是否已经是原生 GIF」。
 * - 有 .gif 扩展名 → 是
 * - 明确静态图扩展名 → 否
 * - 无扩展名/查询式 URL → 抓字节看文件头（原生 GIF 模型有时给这种地址）
 */
export async function isGifSource(imageUrl: string): Promise<boolean> {
  if (isGifImageUrl(imageUrl)) return true
  if (/\.(png|jpe?g|webp)(?:$|[?#])/i.test(imageUrl)) return false
  try {
    return sniffImageMime(await readSourceBuffer(imageUrl)) === 'image/gif'
  } catch {
    return false
  }
}

/** 读取原图 Buffer：支持 data URL / 站内素材 / 远程 http(s) */
async function readSourceBuffer(imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith('data:')) {
    return Buffer.from(imageUrl.split(',')[1] || '', 'base64')
  }
  if (imageUrl.startsWith('/generated/') || imageUrl.startsWith('/api/asset/')) {
    const rel = imageUrl.slice(imageUrl.startsWith('/api/asset/') ? '/api/asset/'.length : '/generated/'.length)
    return Buffer.from(await readFile(join(ASSET_DIR, rel)))
  }
  // 防 SSRF：拉的是用户/上游给的图片地址，不能盲信（可指向内网/云元数据）
  const safe = await checkUrlSafe(imageUrl)
  if (!safe.ok) throw new Error(safe.reason || '图片地址不可访问')
  const resp = await fetch(imageUrl)
  if (!resp.ok) throw new Error(`获取原图失败: ${resp.status}`)
  return Buffer.from(await resp.arrayBuffer())
}
