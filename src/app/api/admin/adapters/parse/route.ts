import { NextRequest } from 'next/server'
import { executeConfiguredAdapter } from '@/lib/adapter-runtime'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })

  const { source, type = 'TYPESCRIPT' } = await request.json()

  if (!source || typeof source !== 'string') {
    throw new ApiHandlerError('源码不能为空', 400)
  }

  let adapter
  try {
    let finalSource = source
    if (type === 'JSON') {
      const parsed = JSON.parse(source)
      if (!parsed || typeof parsed !== 'object') {
        throw new ApiHandlerError('JSON 适配器必须是一个对象', 400)
      }
      finalSource = wrapJsonAdapter(parsed)
    }
    adapter = executeConfiguredAdapter(finalSource)
  } catch (error) {
    if (error instanceof ApiHandlerError) throw error
    throw new ApiHandlerError(error instanceof Error ? error.message : '解析失败', 400)
  }

  const info = {
    name: adapter.name,
    code: adapter.code || null,
    version: adapter.version || null,
    description: adapter.description || null,
    defaults: adapter.defaults || null,
    hasChat: typeof adapter.buildChatRequest === 'function',
    hasImage: typeof adapter.buildImageRequest === 'function',
    hasTest: typeof adapter.buildTestRequest === 'function',
  }

  return success(info, '解析成功')
})

function wrapJsonAdapter(parsed: Record<string, unknown>): string {
  const hooks: string[] = []

  const required = ['buildChatRequest']
  for (const key of required) {
    if (!parsed[key]) {
      throw new Error(`JSON 适配器缺少必填钩子：${key}`)
    }
  }

  const functionKeys = [
    'buildChatRequest',
    'parseChatStreamChunk',
    'parseChatResponse',
    'mapChatError',
    'buildImageRequest',
    'parseImageResponse',
    'mapImageError',
    'buildTestRequest',
    'parseTestResponse',
  ]

  for (const key of functionKeys) {
    const value = parsed[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new Error(`JSON 适配器字段 ${key} 必须是函数字符串`)
    }
    hooks.push(`${key}: ${compileExpression(key, value)},`)
  }

  const metadata = ['name', 'code', 'version', 'description']
  for (const key of metadata) {
    if (parsed[key] !== undefined && typeof parsed[key] === 'string') {
      hooks.unshift(`${key}: ${JSON.stringify(parsed[key])},`)
    }
  }

  if (parsed.defaults && typeof parsed.defaults === 'object') {
    hooks.unshift(`defaults: ${JSON.stringify(parsed.defaults)},`)
  }

  return `const adapter = {\n${hooks.join('\n')}\n}`
}

function compileExpression(key: string, expr: string): string {
  const signature = getSignature(key)
  return `function(${signature}) {\n  try {\n    ${expr}\n  } catch (e) {\n    console.error('Adapter ${key} error:', e)\n    throw e\n  }\n}`
}

function getSignature(key: string): string {
  if (key === 'buildChatRequest') return 'config, params'
  if (key === 'parseChatStreamChunk') return 'chunk'
  if (key === 'parseChatResponse') return 'body'
  if (key === 'mapChatError') return 'status, body'
  if (key === 'buildImageRequest') return 'config, params'
  if (key === 'parseImageResponse') return 'body'
  if (key === 'mapImageError') return 'status, body'
  if (key === 'buildTestRequest') return 'config'
  if (key === 'parseTestResponse') return 'response, body'
  return ''
}
