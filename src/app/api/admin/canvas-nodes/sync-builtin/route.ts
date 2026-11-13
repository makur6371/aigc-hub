import { NextRequest } from 'next/server'
import { syncBuiltinNodes } from '@/lib/sync-builtin-nodes'
import { apiHandler, requireAuth, success } from '@/lib/api-handler'

export const POST = apiHandler(async (request: NextRequest) => {
  // 仍然要求管理员：这个按钮会覆盖 DB 里的内置节点定义，等同于热修生产。
  await requireAuth(request, { admin: true })

  // 与启动时的 syncBuiltinNodes 同一实现：改源码只改一处，不会出现
  // 「按钮同步的内容」和「启动同步的内容」漂移。
  const { synced, updated } = await syncBuiltinNodes()

  return success({ synced, updated }, `同步完成：新增 ${synced} 个，更新 ${updated} 个`)
})
