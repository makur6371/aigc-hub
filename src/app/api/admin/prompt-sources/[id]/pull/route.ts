import { NextRequest } from 'next/server'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'
import { pullPromptSource } from '@/lib/prompt-source-store'

type Ctx = { id: string }

// POST /api/admin/prompt-sources/[id]/pull - 立即拉取单个源
export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  await requireAuth(request, { admin: true })
  const { id } = await params
  const result = await pullPromptSource(id)
  if (!result.ok) {
    return success(result, '拉取失败：' + (result.error || '未知错误'))
  }
  return success(result, '拉取完成：新增 ' + result.inserted + '，更新 ' + result.updated)
})
