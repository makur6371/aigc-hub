// OpenAI-compatible LLM provider proxy
// Now implemented as a thin wrapper over the adapter-driven provider-invoker.
// The adapter system allows custom vendors to override request/response handling
// without modifying this file.

import { invokeChat } from './provider-invoker'
import { prepareLlmReferenceImages } from './upstream-image'
import { getAdapter } from './adapter-runtime'
import type { AdapterToolCall, AdapterToolSpec } from '@/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface ChatResult {
  content: string
  finishReason: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 模型要求的工具调用（非空表示本轮是在「下单动作」而不是「回答」） */
  toolCalls?: AdapterToolCall[]
}

function imageParts(text: string, images: string[]): ChatContentPart[] {
  const parts: ChatContentPart[] = text ? [{ type: 'text', text }] : []
  return parts.concat(images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' } })))
}

/**
 * 把参考图挂到最后一条 user 消息上（多模态）。
 *
 * 保留带工具语义的消息及已有图片，显式参考图只附在最后一条 user 消息。
 */
export function attachVisionImages(
  messages: { role: string; content: string | unknown; tool_calls?: unknown; tool_call_id?: string; name?: string }[],
  images: string[],
): { role: string; content: string | unknown }[] {
  const out = messages.map((m) => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue
    const content = out[i].content
    const parts = imageParts(typeof content === 'string' ? content : '', images)
    out[i].content = Array.isArray(content) ? [...content, ...parts] : parts
    return out
  }
  return out
}

export async function streamChatToUpstream(
  baseUrl: string,
  apiKey: string,
  upstreamModelName: string,
  params: {
    systemPrompt?: string
    messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }[]
    temperature?: number
    maxTokens?: number
    supportsVision?: boolean
    images?: string[]
    /** 工具清单（Agent 动作层）：非空才下发，普通对话调用不受影响 */
    tools?: AdapterToolSpec[]
    toolChoice?: unknown
    /** 思考强度（见 AdapterChatParams.reasoningEffort）：思考模型压低它可省预算/提速 */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
    /**
     * 模型配置的 metadata。用于**模型级**读取 imageTransport
     * （图片传输方式：'url' | 'base64' | 'auto'）—— 优先于 adapter 级声明。
     */
    modelMetadata?: Record<string, unknown> | null
  },
  onChunk: (text: string) => void,
  onReasoningChunk?: (reasoning: string) => void,
  adapterInfo?: { adapterId?: string | null; configJson?: Record<string, unknown> | null },
  timeoutMs?: number,
  /** 调用方 userId：透传给并发闸门做用户级在途限制（Q-D51），不传则不占用户名额 */
  userId?: string,
): Promise<ChatResult> {
  const hasToolSemantics = params.messages.some((msg) => msg.tool_calls || msg.tool_call_id || msg.role === 'tool')
  let finalMessages: { role: string; content: unknown }[] = hasToolSemantics
    ? params.messages
    : [...(params.systemPrompt ? [{ role: 'system', content: params.systemPrompt }] : []), ...params.messages]

  if (params.supportsVision) {
    const embedded = finalMessages.map((msg) => {
      const images: string[] = []
      const content = msg.role === 'user' && typeof msg.content === 'string'
        ? msg.content.replace(/!?\[?\]?\((data:image\/[^;]+;base64,[^)]+)\)/g, (_, url: string) => {
          images.push(url)
          return ''
        })
        : msg.content
      return { msg, images, content }
    })
    const references = (params.images ?? []).filter(Boolean)
    const allImages = [...embedded.flatMap(({ images }) => images), ...references]
    if (allImages.length > 0) {
      const transport = params.modelMetadata?.imageTransport
      const modelMode = transport === 'url' || transport === 'base64' || transport === 'auto' ? transport : undefined
      const adapter = await getAdapter({ adapterId: adapterInfo?.adapterId }).catch(() => null)
      const prepared = await prepareLlmReferenceImages(allImages, modelMode ?? adapter?.chatImageMode ?? 'auto', {
        maxBytes: adapter?.chatImageInlineMaxBytes,
        userId,
      })
      let offset = 0
      finalMessages = embedded.map(({ msg, images, content }) => {
        if (images.length === 0) return msg
        const parts = imageParts(String(content).trim(), prepared.slice(offset, offset + images.length))
        offset += images.length
        return { ...msg, content: parts }
      })
      if (references.length > 0) finalMessages = attachVisionImages(finalMessages, prepared.slice(offset))
    }
  }

  return invokeChat(
    { baseUrl, apiKey, adapterId: adapterInfo?.adapterId, configJson: adapterInfo?.configJson },
    upstreamModelName,
    {
      messages: finalMessages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      stream: true,
      tools: params.tools,
      toolChoice: params.toolChoice,
      reasoningEffort: params.reasoningEffort,
    },
    onChunk,
    onReasoningChunk,
    timeoutMs,
    undefined,
    userId,
  )
}
