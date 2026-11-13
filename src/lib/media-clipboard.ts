/**
 * 图片 / GIF 复制到剪贴板（全站唯一实现）。
 *
 * 浏览器剪贴板的现实约束：
 *   - ClipboardItem 对 `image/gif` 的支持很不稳定（Chrome 常见只接受 PNG）；
 *   - 直接把 GIF 写失败时，退化成「复制首帧 PNG」比报错更有用；
 *   - 再不行就复制 URL，用户至少能拿到地址。
 *
 * 返回值里的 mode 用来给用户一句准确的提示，不要假装动图复制成功。
 */
import { isRemoteUrl, unwrapMediaProxyUrl } from './media-url'

export type CopyMediaMode = 'original' | 'html' | 'first-frame' | 'url'
export type MediaKind = 'image' | 'video' | 'audio'

export interface CopyMediaResult {
  ok: boolean
  mode: CopyMediaMode
  message: string
}

/** 外链走同源代理（绕 CORS）；站内/临时地址直接取 */
function fetchableUrl(url: string): string {
  if (!url || !isRemoteUrl(url)) return url
  return `/api/asset-proxy?u=${encodeURIComponent(url)}`
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(fetchableUrl(url), { credentials: 'include' })
  if (!res.ok) throw new Error(`读取失败（${res.status}）`)
  return res.blob()
}

/** 把任意图片 Blob 解码后转 PNG（GIF 取第一帧） */
async function toPngBlob(blob: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    bitmap = null
  }

  if (!bitmap) {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = objectUrl
      await img.decode()
      bitmap = await createImageBitmap(img)
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  if (!bitmap) return null

  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  } finally {
    bitmap.close()
  }
}

async function writeImage(blob: Blob, type: string): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
  // 浏览器明确声明不支持该 MIME 时不要硬写（失败还会吞掉一次用户手势）
  const supports = (ClipboardItem as unknown as { supports?: (mime: string) => boolean }).supports
  if (typeof supports === 'function' && !supports(type)) return false
  try {
    await navigator.clipboard.write([new ClipboardItem({ [type]: blob })])
    return true
  } catch {
    return false
  }
}

async function writeClipboard(items: Record<string, Blob | string>): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
  try {
    await navigator.clipboard.write([new ClipboardItem(items)])
    return true
  } catch {
    return false
  }
}

/** GIF 字节判断：MIME 可能被上游写错，文件头更可信。 */
async function isGifBlob(blob: Blob): Promise<boolean> {
  if ((blob.type || '').toLowerCase() === 'image/gif') return true
  try {
    const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer())
    const sig = String.fromCharCode(...head)
    return sig === 'GIF87a' || sig === 'GIF89a'
  } catch {
    return false
  }
}

/** 复制出去的链接要能被别处直接访问：代理地址解回原图，站内相对地址补成绝对地址。 */
function absoluteUrlOf(url: string): string {
  const raw = unwrapMediaProxyUrl(url)
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('/')) return new URL(raw, window.location.origin).href
  return raw
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 复制媒体。
 * - 图片：优先原格式；失败转 PNG；再失败复制 URL。
 * - GIF：浏览器支持 image/gif 就复制动图；否则复制「带 <img> 的富文本 + 链接」，
 *   粘贴到支持网页内容的应用里仍会是动图；最后才退化为首帧 PNG。
 * - 视频/音频：复制 URL。
 *
 * 为什么 GIF 不能像 PNG 一样直接进剪贴板：Chromium 系只接受 image/png
 * （ClipboardItem.supports('image/gif') === false），Safari/Firefox 也没有稳定支持。
 * 这是浏览器能力边界，不是本站生成/存储的问题。
 */
export async function copyMediaToClipboard(url: string, kind: MediaKind): Promise<CopyMediaResult> {
  if (!url) throw new Error('没有可复制的地址')

  if (kind !== 'image') {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制')
    await navigator.clipboard.writeText(url)
    return { ok: true, mode: 'url', message: '已复制媒体链接' }
  }

  const blob = await fetchBlob(url)
  const type = (blob.type || '').toLowerCase()
  const isGif = await isGifBlob(blob)

  if (isGif) {
    if (await writeImage(blob, 'image/gif')) {
      return { ok: true, mode: 'original', message: '已复制 GIF 动图' }
    }

    const link = absoluteUrlOf(url)
    const html = `<img src="${escapeAttr(link)}" alt="GIF">`
    if (await writeClipboard({ 'text/html': html, 'text/plain': link })) {
      return {
        ok: true,
        mode: 'html',
        message: '浏览器剪贴板不支持 GIF，已复制动图链接；粘贴到支持网页内容的应用可保留动画',
      }
    }
  }

  if (!isGif && await writeImage(blob, type || 'image/png')) {
    return { ok: true, mode: 'original', message: '已复制图片' }
  }

  const png = await toPngBlob(blob)
  if (png && await writeImage(png, 'image/png')) {
    return {
      ok: true,
      mode: 'first-frame',
      message: isGif ? '已复制首帧；完整动图请用「下载 GIF」保存' : '已复制图片（PNG）',
    }
  }

  if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制')
  await navigator.clipboard.writeText(url)
  return { ok: true, mode: 'url', message: '剪贴板不支持图片，已复制原图链接' }
}

/** 是否是 GIF 地址（兼容站内 hash 文件名与代理地址） */
export function isGifUrl(url: string): boolean {
  if (!url) return false
  try {
    const raw = url.startsWith('/api/asset-proxy?u=')
      ? new URL(url, 'https://example.invalid').searchParams.get('u') || ''
      : url
    return /\.gif(?:$|[?#])/i.test(raw)
  } catch {
    return /\.gif(?:$|[?#])/i.test(url)
  }
}
