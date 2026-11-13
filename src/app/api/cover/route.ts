import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile, rename } from 'fs/promises'
import path from 'path'
import { checkUrlSafe, safeFetch } from '@/lib/ssrf-guard'

// 封面加速中转：服务器端拉取远程封面图并缓存到本地磁盘，避免用户直连慢速外链
// 用法：/api/cover?u=<encodeURIComponent(远程图片URL)>
//
// 性能设计（新设备首载大面积超时的根修）：
// 1. 缓存落持久卷（DATA_DIR），容器重启不清空——冷缓存只发生在真正首次
// 2. 同 URL 并发回源合并（in-flight 去重），几十张封面同时请求只回源一次
// 3. 回源失败/超时快速降级 302 到原图，浏览器直连兜底，不占住响应排队
// 4. 负缓存：拉取失败的 URL 短期内不再重试，避免反复 10s 超时堵住队列
// 5. **落盘前压成缩略图**（2026-09-20 补）：此前是把上游原图整份存下来，
//    实测 497 个文件占了 1.4G（单张最大 7.1MB）—— 封面在列表里只显示几十像素，
//    却按 4K 原图存，既浪费磁盘也让首屏加载更慢。压到最长边 512 的 webp 后通常只有 20~60KB。

const CACHE_DIR = process.env.COVER_CACHE_DIR || path.join(process.env.DATA_DIR || '/data', 'covers')
const NEG_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000

// 进程内 in-flight 去重 + 负缓存
const inflight = new Map<string, Promise<boolean>>()
const negCache = new Map<string, number>()

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const raw = url.searchParams.get('u') || ''
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return new Response('bad protocol', { status: 400 })
  }
  // 防 SSRF：统一走 ssrf-guard（含云元数据 169.254.169.254、十进制/十六进制 IP、
  // DNS 解析后逐个校验）。原先的正则漏了元数据地址，在云主机上等于把实例凭证交出去。
  const safe = await checkUrlSafe(target.toString())
  if (!safe.ok) {
    return new Response(safe.reason || 'host not allowed', { status: 403 })
  }

  const key = createHash('sha1').update(target.toString()).digest('hex')
  const ext = path.extname(target.pathname).slice(0, 5) || '.jpg'
  // 新缓存一律是 webp（落盘前压过缩略图）；同时保留旧命名以便命中历史缓存。
  // 旧缓存里存的是原图、按原扩展名返回，靠 maintenance 的 TTL 自然淘汰。
  const file = path.join(CACHE_DIR, `${key}.webp`)
  const legacyFile = path.join(CACHE_DIR, `${key}${ext}`)

  try {
    const cached = await readFile(file)
    return new Response(new Uint8Array(cached), {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, immutable' },
    })
  } catch { /* 新缓存未命中 */ }
  try {
    const legacy = await readFile(legacyFile)
    return new Response(new Uint8Array(legacy), {
      headers: { 'Content-Type': contentType(ext), 'Cache-Control': 'public, max-age=604800, immutable' },
    })
  } catch { /* 缓存未命中，走拉取 */ }

  // 负缓存期内直接降级 302，不排队
  const negAt = negCache.get(key)
  if (negAt && Date.now() - negAt < NEG_TTL_MS) {
    return Response.redirect(target.toString(), 302)
  }

  // in-flight 合并：同 URL 并发请求共享一次回源
  let task = inflight.get(key)
  if (!task) {
    task = fetchAndCache(target.toString(), file)
      .finally(() => inflight.delete(key))
    inflight.set(key, task)
  }
  const ok = await task

  if (ok) {
    try {
      const cached = await readFile(file)
      return new Response(new Uint8Array(cached), {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, immutable' },
      })
    } catch { /* 落盘竞态，走降级 */ }
  }
  // 快速降级：302 让浏览器直连原图，不阻塞渲染
  negCache.set(key, Date.now())
  return Response.redirect(target.toString(), 302)
}

/** 封面缩略图参数：列表展示足够，且能显著压体积 */
const COVER_MAX_EDGE = 512
const COVER_WEBP_QUALITY = 72

/**
 * 把回源拿到的图压成列表用的缩略图。
 *
 * 为什么必须做：封面在列表里只显示几十像素，此前却按上游原图（可达 4K）整份缓存，
 * 实测 497 个文件 1.4G、单张最大 7.1MB —— 磁盘与首屏加载双输。
 *
 * 只处理位图：SVG 是矢量（本就不大，且 sharp 默认不栅格化是对的），GIF 动图压了会只剩一帧。
 * 其余情况若 sharp 处理失败，由调用方 catch 退回原图。
 */
async function shrinkCover(raw: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const meta = await sharp(raw).metadata()
  if (meta.format === 'svg' || meta.format === 'gif') return raw
  return sharp(raw)
    .rotate() // 按 EXIF 摆正，否则手机拍的竖图在列表里会躺着
    .resize({ width: COVER_MAX_EDGE, height: COVER_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: COVER_WEBP_QUALITY })
    .toBuffer()
}

// 回源拉图并原子落盘；失败返回 false（不抛出，由调用方降级）
async function fetchAndCache(targetStr: string, file: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    // safeFetch：校验 + 逐跳校验重定向（堵住「合法 URL 302 到内网」绕过）
    const upstream = await safeFetch(targetStr, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 AigcHubCovers/1.0' } })
    clearTimeout(timer)
    if (!upstream.ok) return false
    const raw = Buffer.from(await upstream.arrayBuffer())
    if (raw.length === 0 || raw.length > 15 * 1024 * 1024) return false
    // 落盘前压成缩略图：封面只用于列表/卡片展示，不需要原图分辨率。
    // 压缩失败时退回原图（宁可用大图，也不能让封面裂掉）。
    const buf = await shrinkCover(raw).catch(() => raw)
    // 原子写：先写临时文件再 rename，避免并发读到半截文件
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, file).catch(async () => { await writeFile(file, buf) })
    return true
  } catch {
    return false
  }
}

function contentType(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}
