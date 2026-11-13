import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAdapter, buildAdapterConfig } from '@/lib/adapter-runtime'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const GET = apiHandler<{ id: string }>(
  async (_request: NextRequest, { params }) => {
    await requireAuth(_request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const provider = await prisma.apiProvider.findUnique({ where: { id } })
    if (!provider) {
      throw new ApiHandlerError('Provider 不存在', 404)
    }

    const adapter = await getAdapter({ adapterId: provider.adapterId })
    if (!adapter.buildTestRequest) {
      throw new ApiHandlerError('当前 Adapter 不支持加载模型列表', 400)
    }

    const config = buildAdapterConfig(
      provider.baseUrl,
      provider.apiKey,
      '',
      provider.configJson as Record<string, unknown> | undefined
    )
    const testRequest = adapter.buildTestRequest(config)

    const path = '/models'
    const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        ...(testRequest.headers || {}),
        Authorization: `Bearer ${config.apiKey}`,
      },
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ApiHandlerError(`加载失败：${response.status} ${text}`, 502)
    }

    const body = await response.json()
    const models = Array.isArray(body.data)
      ? body.data
          .map((m: { id?: string; object?: string }) => ({
            id: m.id || '',
            object: m.object || 'model',
          }))
          .filter((m: { id: string }) => m.id)
      : []

    return success(models, `已加载 ${models.length} 个模型`)
  }
)
