import { NextRequest } from 'next/server'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'
import { pullAllPromptSources } from '@/lib/prompt-source-store'

// POST /api/admin/prompt-sources/pull-all - 拉取所有启用的源
export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const results = await pullAllPromptSources()
  const ok = results.filter((r) => r.ok)
  const inserted = ok.reduce((sum, r) => sum + r.inserted, 0)
  const updated = ok.reduce((sum, r) => sum + r.updated, 0)
  const failed = results.length - ok.length
  return success(
    { results, inserted, updated, failed },
    '全部拉取完成：新增 ' + inserted + '，更新 ' + updated + (failed ? '，失败 ' + failed + ' 个' : '')
  )
})
