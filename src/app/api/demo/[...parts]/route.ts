import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'

function authorized(request: NextRequest) {
  const secret = process.env.JWT_SECRET
  if (process.env.APP_ENABLE_DEMO !== '1' || !secret) return false
  const expected = Buffer.from('Bearer ' + createHmac('sha256', secret).update('local-demo-v1').digest('hex'))
  const supplied = Buffer.from(request.headers.get('authorization') || '')
  return supplied.length === expected.length && timingSafeEqual(expected, supplied)
}

function endpoint(request: NextRequest) {
  return request.nextUrl.pathname.replace(/^\/api\/demo\//, '')
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const path = endpoint(request)
  if (path === 'models') return Response.json({ data: ['demo-text', 'demo-image', 'demo-video'].map(id => ({ id })) })
  const job = /^videos\/(\d{13})-[a-f0-9-]+$/.exec(path)
  if (job) return Response.json(Date.now() - Number(job[1]) < 4500
    ? { status: 'pending' }
    : { status: 'completed', video_url: new URL('/demo/preview.mp4', process.env.NEXT_PUBLIC_APP_URL || request.url).href })
  return new Response(null, { status: 404 })
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const path = endpoint(request)
  if (path === 'videos/generations') return Response.json({ task_id: Date.now() + '-' + randomUUID() })
  if (path === 'images/generations' || path === 'images/edits') {
    if (path === 'images/edits') {
      const form = await request.formData().catch(() => null)
      if (!form || ![...form.values()].some(value => value instanceof File && value.size > 0)) {
        return Response.json({ error: { message: 'Expected a multipart image file.' } }, { status: 400 })
      }
    }
    const image = await readFile(join(process.cwd(), 'public', 'demo', 'preview.png'))
    return Response.json({ data: [{ b64_json: image.toString('base64') }] })
  }
  if (path !== 'chat/completions') return new Response(null, { status: 404 })
  const body = await request.json().catch(() => null)
  const content = '这是 AIGC Hub 的本地演示回复。配置语言模型后，可让 Agent 规划创作任务。'
  if (!body?.stream) return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
  return new Response(
    ['data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]', '', ''].join('\n'),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } },
  )
}
