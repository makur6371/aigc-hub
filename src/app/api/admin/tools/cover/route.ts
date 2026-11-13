import { NextRequest } from 'next/server'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { saveToolCover, TOOL_COVER_MAX_SIZE } from '@/lib/tool-cover'

// 管理员上传工具封面（4:3 预览图）。
// 单独一条路由而不是复用 /api/assets：封面是平台资产，不该计入任何用户的素材配额，
// 也不该被素材的过期清理与孤儿回收波及（详见 lib/tool-cover.ts 注释）。
export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })

  const contentType = request.headers.get('content-type') || ''
  let buffer: Buffer
  let mime: string | undefined

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') throw new ApiHandlerError('未收到文件', 400)
    buffer = Buffer.from(await (file as File).arrayBuffer())
    mime = (file as File).type || undefined
  } else {
    const body = await request.json().catch(() => null)
    if (!body || typeof body.data !== 'string') throw new ApiHandlerError('未收到文件数据', 400)
    const base64 = body.data.includes(',') ? body.data.split(',')[1] : body.data
    buffer = Buffer.from(base64, 'base64')
    mime = typeof body.mime === 'string' ? body.mime : undefined
  }

  if (buffer.byteLength === 0) throw new ApiHandlerError('文件为空', 400)
  if (buffer.byteLength > TOOL_COVER_MAX_SIZE) {
    throw new ApiHandlerError(`封面超过 ${TOOL_COVER_MAX_SIZE / 1024 / 1024}MB 限制`, 400)
  }
  if (mime && !mime.startsWith('image/')) {
    throw new ApiHandlerError('封面必须是图片（PNG / JPG / WebP / GIF）', 400)
  }

  const url = await saveToolCover(buffer, mime)
  return success({ url }, '封面已上传')
})
