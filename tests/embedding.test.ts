import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * embedding 语义检索 —— 锁死「不可用时静默降级 + 原因可观测」的行为。
 *
 * 所以它保留自己的请求实现；但必须与统一通路对齐两件横切能力：
 *   1. 走 withUpstreamGate（否则突发搜索能绕过在途上限把上游压垮）
 *   2. 失败不能只 return null —— key 过期/额度耗尽要能在日志里看到原因
 *
 * 这里的用例不碰真实网络：mock global.fetch。
 */

// 每个用例独立设置环境变量 → 用 vi.resetModules 重新 import，避免模块级缓存
async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return import('@/lib/embedding')
}

const CFG = {
  EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
  EMBEDDING_API_KEY: 'sk-test',
  EMBEDDING_MODEL: 'bge-m3',
}

describe('embedding —— 语义检索的降级与可观测性', () => {
  const originals = { ...process.env }
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const k of Object.keys(process.env)) {
      if (!(k in originals)) delete process.env[k]
    }
    Object.assign(process.env, originals)
    vi.unstubAllGlobals()
  })

  it('未配置凭据 → 直接返回 null，且不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { embeddingClient } = await loadModule({
      EMBEDDING_BASE_URL: undefined,
      EMBEDDING_API_KEY: undefined,
      EMBEDDING_MODEL: undefined,
    })

    expect(await embeddingClient.embed('hello')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('空文本 → 返回 null，且不发请求（避免无谓配额消耗）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { embeddingClient } = await loadModule(CFG)

    expect(await embeddingClient.embed('   ')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('正常返回 → 解出向量（data[0].embedding）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const { embeddingClient } = await loadModule(CFG)

    expect(await embeddingClient.embed('hello')).toEqual([0.1, 0.2, 0.3])
  })

  it('请求 URL / 鉴权头 / body 形状正确（OpenAI 兼容 embeddings）', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ embedding: [1] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchSpy)
    const { embeddingClient } = await loadModule(CFG)

    await embeddingClient.embed('hello')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://embed.example.com/v1/embeddings')   // 不重复 /v1
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'bge-m3', input: 'hello' })
  })

  it('上游非 2xx → 返回 null（降级），但必须打日志说明原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )))
    const { embeddingClient } = await loadModule(CFG)

    expect(await embeddingClient.embed('hello')).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    const logged = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('401')
    expect(logged).toContain('invalid api key')   // 不能只报状态码，要带上上游原文
  })

  it('网络异常 → 返回 null 且不抛（搜索不能因为语义检索挂掉而失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    const { embeddingClient } = await loadModule(CFG)

    await expect(embeddingClient.embed('hello')).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('返回体缺 data[0].embedding → null（不返回畸形向量去污染相似度计算）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const { embeddingClient } = await loadModule(CFG)

    expect(await embeddingClient.embed('hello')).toBeNull()
  })

  it('输入超长时截断到 2000 字符（上游对 input 长度有限制）', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ embedding: [1] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchSpy)
    const { embeddingClient } = await loadModule(CFG)

    await embeddingClient.embed('x'.repeat(5000))

    const body = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.input).toHaveLength(2000)
  })
})

describe('cosineSimilarity —— 相似度计算边界', () => {
  it('完全一致 → 1', async () => {
    const { cosineSimilarity } = await loadModule({})
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('正交 → 0', async () => {
    const { cosineSimilarity } = await loadModule({})
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('长度不一致 / 空 / 零向量 → 0（不产生 NaN）', async () => {
    const { cosineSimilarity } = await loadModule({})
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
  })
})
