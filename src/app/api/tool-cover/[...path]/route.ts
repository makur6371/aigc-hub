import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { TOOL_COVER_DIR, toolCoverMime } from '@/lib/tool-cover'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 工具封面服务：从持久卷读管理员上传的封面图。
// 公开可读（封面是平台展示资产，不含用户隐私），文件名是 crypto 随机 UUID。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params
  const file = join(TOOL_COVER_DIR, ...segments)
  const base = resolve(TOOL_COVER_DIR)
  // 防目录穿越（兼容 Windows 反斜杠）
  if (file !== base && !file.startsWith(base + '/') && !file.startsWith(base + '\\')) {
    return new Response('forbidden', { status: 403 })
  }

  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response('not found', { status: 404 })
    const buf = await readFile(file)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': toolCoverMime(file),
        'Cache-Control': 'public, max-age=2592000, immutable',
        // 与素材服务同一套防护：禁止内容嗅探（封面 MIME 表本身就不含 svg，双保险）
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
