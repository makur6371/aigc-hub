import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiFetch } from '@/lib/api-client'

// apiFetch 是所有前端请求的统一入口，调用点大量使用 `void apiFetch(...)`（不接 promise）。
// 旧实现只处理了「服务器返回非 2xx」，没处理 **fetch 本身 reject**（离线 / 服务重启 / DNS）。
// 那种情况下 promise 永远是 rejected → 每个 void 调用点都变成 unhandled rejection。
// 这里锁死：网络层失败必须与「请求失败」同形状返回，绝不抛。

describe('apiFetch —— 网络失败不能抛', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetch reject（离线/服务重启）→ 返回 { success:false } 而不是抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const res = await apiFetch('/api/whatever')
    expect(res.success).toBe(false)
    expect(res.data).toBeNull()
    expect(typeof res.message).toBe('string')
  })

  it('HTTP 非 2xx → 返回 message（原有行为不变）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, message: '未登录' }), { status: 401 }),
    ))
    const res = await apiFetch('/api/whatever', { silent401: true })
    expect(res.success).toBe(false)
    expect(res.message).toBe('未登录')
  })

  it('正常响应 → 透传 data（原有行为不变）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { id: 1 } }), { status: 200 }),
    ))
    const res = await apiFetch<{ id: number }>('/api/whatever')
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ id: 1 })
  })
})
