import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { invokeTest } from '@/lib/provider-invoker'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const POST = apiHandler<{ id: string }>(
  async (request: NextRequest, { params }) => {
    await requireAuth(request, { admin: true })
    const { id } = await params

    const prisma = await getPrisma()
    const provider = await prisma.apiProvider.findUnique({ where: { id } })
    if (!provider) {
      throw new ApiHandlerError('Provider 不存在', 404)
    }

    const result = await invokeTest({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      adapterId: provider.adapterId,
      configJson: provider.configJson as Record<string, unknown> | null,
    })

    return success(result, result.message)
  }
)
