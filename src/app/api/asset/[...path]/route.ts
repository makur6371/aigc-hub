import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import { join, resolve, extname } from 'path'
import { ASSET_DIR } from '@/lib/asset-store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // 注意：这里**故意不映射 .svg**。SVG 可内嵌 <script>，而素材是公网可读的，
  // 一旦以 image/svg+xml 直出就是同源 XSS（能读 cookie）。落盘的 SVG 会走
  // application/octet-stream（下载而非渲染），配合 pickExt 的白名单双重兜底。
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

// 素材服务：从持久卷 ASSET_DIR 读运行时动态写入的素材并以正确 MIME 返回。
// 不能用 public/（Next standalone 只服务构建时快照），也不能用 /generated/（被该快照抢占）。
// 同宿主共享链接：素材 URL 不含用户敏感信息，仅 crypto 随机文件名，公网可读（与旧 /generated 行为一致）；
// 若需更严可在此基于 cookie 校验属主，但不强制。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params
  const file = resolve(join(ASSET_DIR, ...segments))
  const base = resolve(ASSET_DIR)
  // 防目录穿越（path.sep 兼容 Windows 反斜杠；同时放行 / 与 \ 分隔的路径）
  if (file !== base && !file.startsWith(base + '/') && !file.startsWith(base + '\\')) {
    return new Response('forbidden', { status: 403 })
  }

  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response('not found', { status: 404 })
    const buf = await readFile(file)
    const mime = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=2592000, immutable',
        // 兜底：即便将来有人把 svg/html 加回 MIME 表，也不让浏览器把它当页面执行。
        // 只用 nosniff（不加 CSP sandbox —— 那对直接打开图片 URL 的场景会加限制，
        // 而 XSS 风险已由「MIME 表移除 .svg + pickExt 白名单」从源头挡掉）。
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
