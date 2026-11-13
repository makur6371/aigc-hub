/**
 * Embedding 语义搜索封装（作品广场/提示词库用）。
 * 凭据走环境变量，未配置时返回 null（调用方 fallback 关键词搜索，不阻塞）。
 *
 * 环境变量：
 * - EMBEDDING_BASE_URL  OpenAI 兼容 base URL（含 /v1）
 * - EMBEDDING_API_KEY
 * - EMBEDDING_MODEL     模型名，如 text-embedding-3-small / bge-m3 等
 *
 * 为什么不走 provider-invoker / adapter：
 * 凭据来自**环境变量**而非 DB 的 api_providers（生产实测：EMBEDDING_BASE_URL 直指
 * 形状不同（input/embedding 而非 messages/choices）。
 * 按「不要为了形式统一而强行统一不合理的业务协议」，这里保留自己的请求实现，
 * 只与统一通路对齐**横切能力**：并发闸门 + 失败可观测。
 */

import { withUpstreamGate } from './concurrency'

export interface EmbeddingClient {
  /** 把文本转成向量；未配置凭据时返回 null */
  embed(text: string): Promise<number[] | null>
}

export function getEmbeddingConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = process.env.EMBEDDING_BASE_URL
  const apiKey = process.env.EMBEDDING_API_KEY
  const model = process.env.EMBEDDING_MODEL
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model }
}

/** 失败只在日志里说一次原因，避免每次搜索都刷屏 */
let lastWarned = ''

function warnOnce(reason: string) {
  if (reason === lastWarned) return
  lastWarned = reason
  console.warn('[embedding] 语义检索不可用，已回退关键词搜索:', reason)
}

const client: EmbeddingClient = {
  async embed(text) {
    const cfg = getEmbeddingConfig()
    if (!cfg || !text.trim()) return null
    // 与 chat/image/video/audio 一样走统一并发闸门：
    // 否则突发搜索能绕过「在途上限 + 派发速率」，把上游压垮。
    return withUpstreamGate(async () => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 20_000)
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: cfg.model, input: text.trim().slice(0, 2000) }),
          signal: controller.signal,
        })
        if (!res.ok) {
          // 以前这里直接 return null，语义检索静默降级成关键词搜索，
          // 运维看不到任何痕迹（key 过期/额度耗尽都会变成「搜索变笨了」这种玄学反馈）。
          let detail = ''
          try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
          warnOnce(`上游返回 ${res.status}${detail ? ': ' + detail : ''}`)
          return null
        }
        const body = await res.json()
        const vec = body?.data?.[0]?.embedding
        return Array.isArray(vec) ? vec.map(Number) : null
      } catch (err) {
        warnOnce(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        clearTimeout(timeoutId)
      }
    })
  },
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export { client as embeddingClient }
