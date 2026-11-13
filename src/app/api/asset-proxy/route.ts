import { NextRequest } from 'next/server'
import { safeFetch } from '@/lib/ssrf-guard'

const FETCH_TIMEOUT_MS = 10000

export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('u') || ''
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return new Response('bad protocol', { status: 400 })
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    // safeFetch：校验 + 逐跳校验重定向（堵住「合法 URL 302 到内网」绕过）
    const upstream = await safeFetch(target.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 AigcHubAssetProxy/1.0' },
    })
    clearTimeout(timer)
    if (!upstream.ok) return new Response('upstream error', { status: 502 })

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/')) {
      return new Response('unsupported type', { status: 415 })
    }
    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Cache-Control', 'public, max-age=300')
    return new Response(upstream.body, { headers })
  } catch {
    return new Response('upstream timeout', { status: 504 })
  }
}
