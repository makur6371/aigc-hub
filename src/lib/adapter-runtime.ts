import { createHash } from 'crypto'
import { getPrisma } from './prisma'
import { OPENAI_COMPATIBLE_ADAPTER_SOURCE } from './adapters/openai-compatible'
import { OPENAI_IMAGE_EDITS_ADAPTER_SOURCE } from './adapters/openai-image-edits'
import { enhanceWithProfile } from './adapters/resolver'
import type { RuntimeProviderAdapter, AdapterConfig, AdapterChatParams } from '@/types'
import vm from 'node:vm'

// adapter 参数类型统一来自 @/types（Adapter* 前缀），这里以短名 re-export 保持内部与下游引用稳定
export type {
  AdapterConfig,
  AdapterChatParams as ChatParams,
  AdapterImageParams as ImageParams,
  AdapterVideoParams as VideoParams,
  AdapterVideoStatus as VideoStatus,
  AdapterAudioParams as AudioParams,
  AdapterAudioStatus as AudioStatus,
  AdapterTokenUsage as TokenUsage,
  AdapterChatStreamChunk as ChatStreamChunk,
  AdapterChatResponse as ChatResponse,
} from '@/types'

const adapterCache = new Map<string, RuntimeProviderAdapter>()

const BUILTIN_ADAPTER_CODE = 'openai-compatible'

function getCacheKey(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

function createSandbox() {
  // 注入给 adapter 沙箱的辅助函数：让声明式 fieldMap（applyChatFieldMap）可在 adapter source 里调用。
  // Helpers for trusted adapter code.
  const helpers = {
    __applyChatFieldMap: (
      config: AdapterConfig,
      params: AdapterChatParams,
      fieldMap: NonNullable<RuntimeProviderAdapter['fieldMap']>
    ) => applyChatFieldMap(config, params, fieldMap),
  }
  return {
    ...helpers,
    JSON,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (str: string) => Buffer.from(str, 'binary').toString('base64'),
    atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
  }
}

export function executeAdapterCode(source: string): RuntimeProviderAdapter {
  const key = getCacheKey(source)
  if (adapterCache.has(key)) {
    return adapterCache.get(key)!
  }

  // Only evaluate trusted adapter code. The VM is not a security boundary.
  // 源码是对象字面量(方法内有 return),必须包成函数体才能跑
  const sandbox = createSandbox()
  let adapter: unknown
  try {
    const wrapped = `(function(){ "use strict";\n${source}\n;return adapter; })()`
    const script = new vm.Script(wrapped, { filename: 'adapter.js' })
    const context = vm.createContext(sandbox)
    adapter = script.runInContext(context, { timeout: 5000 })
  } catch (err) {
    throw new Error(`Adapter 代码执行失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!adapter || typeof adapter !== 'object') {
    throw new Error('Adapter 必须返回一个对象')
  }

  // 声明式 profile → 补齐默认钩子（鉴权头 / chat / image / video / test）。
  // 手写实现在前优先，未声明 profile 则原样返回，行为完全不变。
  const resolved = enhanceWithProfile(adapter as RuntimeProviderAdapter)

  // 至少要实现一种能力钩子。视频/图像/音频专用 adapter 不需要 buildChatRequest
  const hasAnyCapability =
    typeof resolved.buildChatRequest === 'function' ||
    typeof resolved.buildImageRequest === 'function' ||
    typeof resolved.buildVideoRequest === 'function' ||
    typeof resolved.buildAudioRequest === 'function'
  if (!hasAnyCapability) {
    throw new Error('Adapter 必须实现 chat / image / video / audio 中至少一种能力')
  }

  adapterCache.set(key, resolved as RuntimeProviderAdapter)
  return resolved as RuntimeProviderAdapter
}

export function executeConfiguredAdapter(source: string): RuntimeProviderAdapter {
  if (source !== OPENAI_COMPATIBLE_ADAPTER_SOURCE && source !== OPENAI_IMAGE_EDITS_ADAPTER_SOURCE
      && process.env.APP_ENABLE_TRUSTED_CODE !== '1') {
    throw new Error('自定义适配器代码未启用')
  }
  return executeAdapterCode(source)
}

export async function getAdapter(providerOrCode: { adapterId?: string | null; adapterCode?: string } | string): Promise<RuntimeProviderAdapter> {
  if (typeof providerOrCode === 'string') {
    if (providerOrCode === BUILTIN_ADAPTER_CODE) {
      return executeAdapterCode(OPENAI_COMPATIBLE_ADAPTER_SOURCE)
    }
    const prisma = await getPrisma()
    const dbAdapter = await prisma.providerAdapter.findUnique({ where: { code: providerOrCode } })
    if (!dbAdapter || !dbAdapter.isActive) {
      throw new Error(`Adapter ${providerOrCode} 不存在或未启用`)
    }
    if (dbAdapter.code === BUILTIN_ADAPTER_CODE) {
      return executeAdapterCode(OPENAI_COMPATIBLE_ADAPTER_SOURCE)
    }
    if (dbAdapter.isBuiltin && dbAdapter.code === 'openai-image-edits') return executeAdapterCode(OPENAI_IMAGE_EDITS_ADAPTER_SOURCE)
    return executeConfiguredAdapter(dbAdapter.source)
  }

  const { adapterId, adapterCode } = providerOrCode

  if (adapterCode) {
    return executeConfiguredAdapter(adapterCode)
  }

  if (adapterId) {
    const prisma = await getPrisma()
    const dbAdapter = await prisma.providerAdapter.findUnique({ where: { id: adapterId } })
    if (!dbAdapter || !dbAdapter.isActive) {
      throw new Error('指定的 Adapter 不存在或未启用')
    }
    // 内置 openai-compatible adapter 统一用最新源码（DB 旧记录缺少视频等新能力）
    if (dbAdapter.code === BUILTIN_ADAPTER_CODE) {
      return executeAdapterCode(OPENAI_COMPATIBLE_ADAPTER_SOURCE)
    }
    if (dbAdapter.isBuiltin && dbAdapter.code === 'openai-image-edits') return executeAdapterCode(OPENAI_IMAGE_EDITS_ADAPTER_SOURCE)
    return executeConfiguredAdapter(dbAdapter.source)
  }

  return executeAdapterCode(OPENAI_COMPATIBLE_ADAPTER_SOURCE)
}

export function buildAdapterConfig(
  baseUrl: string,
  apiKey: string | null,
  modelName: string,
  extraConfig: Record<string, unknown> = {}
): AdapterConfig {
  return {
    baseUrl,
    apiKey,
    modelName,
    ...extraConfig,
  }
}

/**
 * 声明式请求体构建：把内部统一 ChatParams + fieldMap 转成厂商请求体。
 * 处理：字段名别名（maxTokens→max_new_tokens）、值缩放（temperature 0~1→0~100）、
 *       system 分离（Claude 顶层 system 字段 vs 内联 messages）。
 * 厂商 adapter 的 buildChatRequest 可直接复用本函数；极端差异再覆盖。
 */
export function applyChatFieldMap(
  config: AdapterConfig,
  params: AdapterChatParams,
  fieldMap: NonNullable<RuntimeProviderAdapter['fieldMap']>
): { messages: unknown[]; extra: Record<string, unknown> } {
  const aliases = fieldMap.aliases || {}
  const scales = fieldMap.scales || {}
  const mode = fieldMap.systemMessageMode || 'inline'

  // 处理 messages：'separate' 时把 system 抽出来，'inline' 保持在 messages 里
  let system: unknown = undefined
  let messages = params.messages ?? []
  if (mode === 'separate') {
    const sys = messages.find((m) => m.role === 'system')
    if (sys) system = (sys as { content: unknown }).content
    messages = messages.filter((m) => m.role !== 'system')
  }

  // 统一内部参数 → 厂商字段（应用别名 + 缩放），只取有值的
  const put = (body: Record<string, unknown>, internal: string, value: unknown) => {
    if (value === undefined || value === null) return
    const key = aliases[internal] || internal
    const sc = scales[internal]
    let v = value
    if (sc && typeof value === 'number') {
      v = Math.round((value as number) * sc.scale + (sc.offset || 0))
    }
    body[key] = v
  }

  const extra: Record<string, unknown> = {}
  put(extra, 'model', config.modelName)
  put(extra, 'temperature', params.temperature)
  put(extra, 'max_tokens', params.maxTokens) // 别名会覆盖到 max_new_tokens 等
  if (mode === 'separate' && system !== undefined) {
    extra.system = system
  }
  if (params.stream !== undefined) put(extra, 'stream', params.stream)

  return { messages, extra }
}
