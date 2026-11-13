import { isEphemeralUrl, unwrapMediaProxyUrl } from '@/lib/media-url'
// ===== 成果区批量下载 =====
//
// 成果可能是三类地址：
//   1) 站内 /api/asset/... 或 /generated/... —— 同源，直接 fetch
//   2) 上游 http(s) 外链 —— 可能没有 CORS 头，fetch 会失败；走 /api/asset-proxy 中转（原图代拉）
//   3) blob:（本地拖入/编辑产出）—— 同源 blob，直接 fetch
//
// 下载策略：单张直接触发浏览器下载；多张打包成 zip。
// zip 用最小实现（store 模式不压缩）—— 图片/视频本身已压缩，再压收益极低，
// 而引入 jszip 这类依赖只为打几个文件不划算。

export type DownloadItem = { url: string; kind: 'image' | 'video' | 'audio'; name?: string }

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
}

const DEFAULT_EXT: Record<DownloadItem['kind'], string> = {
  image: '.png',
  video: '.mp4',
  audio: '.mp3',
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** 从文件头识别真实格式：上游/代理可能给错 MIME，字节不会说谎。 */
export function sniffMediaExt(bytes: Uint8Array): string | null {
  if (bytes.length >= 6) {
    const head = ascii(bytes, 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return '.gif'
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (
    bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 12) === 'WEBP'
  ) return '.webp'
  return null
}

/** 从 URL 猜扩展名；解不开返回 null，不在这里给默认值。 */
function extOfUrl(url: string): string | null {
  try {
    // 用 media-url 的统一判定：blob:/data: 没有可解析的路径，跳过查扩展名
    const raw = unwrapMediaProxyUrl(url)
    const path = isEphemeralUrl(raw) ? '' : new URL(raw, 'http://x').pathname
    const m = path.match(/\.(png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|mp3|wav|m4a|ogg)$/i)
    if (m) return `.${m[1].toLowerCase()}`
  } catch { /* 忽略 */ }
  return null
}

/**
 * 决定下载文件的扩展名。
 *
 * 优先级：文件头 > 响应 MIME > URL > kind 默认值。
 * 为什么不能只看 URL：灯箱里的外链会包成 `/api/asset-proxy?u=...gif`，
 * 路径本身没有 `.gif`，只看 URL 会把 GIF 存成 `.png` —— 下载后看起来只有首帧。
 */
export function pickDownloadExt(opts: {
  url: string
  kind: DownloadItem['kind']
  mime?: string
  bytes?: Uint8Array
}): string {
  const sniffed = opts.bytes ? sniffMediaExt(opts.bytes) : null
  if (sniffed) return sniffed
  const mime = (opts.mime || '').split(';')[0].trim().toLowerCase()
  if (MIME_EXT[mime]) return MIME_EXT[mime]
  return extOfUrl(opts.url) || DEFAULT_EXT[opts.kind]
}

/** 文件名：非法字符替换掉，避免 Windows 下存不下来 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
}

/** 把成果地址换成浏览器能直接抓取的同源地址 */
// 站内/临时原样；外链走原图代理（服务端代拉绕开 CORS），下载保持原分辨率。
function fetchableUrl(url: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return url
  return `/api/asset-proxy?u=${encodeURIComponent(url)}`
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(fetchableUrl(url), { credentials: 'include' })
  if (!res.ok) throw new Error(`下载失败（${res.status}）`)
  return res.blob()
}

/** 触发一次浏览器下载 */
function triggerDownload(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及下载，延后释放
  setTimeout(() => URL.revokeObjectURL(href), 10000)
}

// ===== 最小 ZIP 写入器（store 模式，不压缩）=====

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

type ZipEntry = { name: string; data: Uint8Array }

/** 组一个 zip（store 模式）。文件名置 UTF-8 flag(0x800)，中文名不会乱码。 */
function buildZip(entries: ZipEntry[]): Blob {
  const chunks: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length

    // 本地文件头
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)      // version needed
    lv.setUint16(6, 0x0800, true)  // flag: UTF-8 文件名
    lv.setUint16(8, 0, true)       // 压缩方法 0 = store
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    // 显式取 .buffer 切片：TS 的 BlobPart 只接受 ArrayBuffer 视图，
    // 直接传 Uint8Array 在 SharedArrayBuffer 场景下类型不兼容
    chunks.push(local.buffer as ArrayBuffer, e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer)

    // 中央目录项
    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + size
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) { chunks.push(c.buffer as ArrayBuffer); centralSize += c.length }

  // 中央目录结束记录
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralStart, true)
  chunks.push(end.buffer as ArrayBuffer)

  return new Blob(chunks, { type: 'application/zip' })
}

/**
 * 下载成果。
 * 单张直接下载；多张打包 zip。
 * 返回成功/失败数量，让调用方给出准确反馈（而不是笼统的「下载完成」）。
 */
export async function downloadResults(
  items: DownloadItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number }> {
  const valid = items.filter((i) => i.url)
  if (valid.length === 0) return { ok: 0, failed: 0 }

  if (valid.length === 1) {
    const it = valid[0]
    try {
      const blob = await fetchBlob(it.url)
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
      const ext = pickDownloadExt({ url: it.url, kind: it.kind, mime: blob.type, bytes: head })
      triggerDownload(blob, `${safeName(it.name || '成果')}${ext}`)
      return { ok: 1, failed: 0 }
    } catch {
      return { ok: 0, failed: 1 }
    }
  }

  const entries: ZipEntry[] = []
  let failed = 0
  let done = 0
  for (const [i, it] of valid.entries()) {
    try {
      const blob = await fetchBlob(it.url)
      const buf = new Uint8Array(await blob.arrayBuffer())
      const ext = pickDownloadExt({
        url: it.url,
        kind: it.kind,
        mime: blob.type,
        bytes: buf.subarray(0, 16),
      })
      const base = safeName(it.name || `成果-${i + 1}`)
      // 同名时加序号，避免 zip 里互相覆盖
      let name = `${base}${ext}`
      let n = 2
      const used = new Set(entries.map((e) => e.name))
      while (used.has(name)) name = `${base}-${n++}${ext}`
      entries.push({ name, data: buf })
    } catch {
      failed++
    } finally {
      done++
      onProgress?.(done, valid.length)
    }
  }

  if (entries.length === 0) return { ok: 0, failed }

  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  triggerDownload(buildZip(entries), `成果-${stamp}.zip`)
  return { ok: entries.length, failed }
}
