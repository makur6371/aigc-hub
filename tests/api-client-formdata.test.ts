import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `apiFetch` 必须支持 FormData 上传（Q-810）。
 *
 * ===== 原来的洞 =====
 * `apiFetch` 无条件写 `Content-Type: application/json`。对 FormData 这是**致命**的：
 * multipart 的边界（boundary）由浏览器自动生成并写进 Content-Type，
 * 手动固定成 JSON 会让服务端解析不出文件 —— 于是所有上传调用点只能绕过 apiFetch 用裸 fetch，
 * 连带丢掉「401 → 跳登录」的统一处理（上传中会话过期只会得到一个看不懂的「上传失败」）。
 *
 * 这条测试锁两件事：
 *   ① FormData 请求**不得**带 JSON Content-Type（让浏览器自己设）；
 *   ② 普通 JSON 请求**仍然**带 JSON Content-Type（别为了修上传把别处弄坏）。
 */

const mocks = vi.hoisted(() => ({ handle401: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({ handle401: mocks.handle401 }))

import { apiFetch } from '@/lib/api-client'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('FormData 上传', () => {
  it('不设 Content-Type（否则 multipart 的 boundary 会被破坏）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ success: true, data: { url: '/a.png' } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('FormData', class {
      private parts: unknown[] = []
      append() { this.parts.push(1) }
    })

    const fd = new (globalThis as unknown as { FormData: new () => FormData }).FormData()
    await apiFetch('/api/assets', { method: 'POST', body: fd })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type'], 'FormData 请求不能带 JSON Content-Type').toBeUndefined()
  })

  it('上传成功时正常返回 data（不被 Content-Type 分支影响）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ success: true, data: { url: '/a.png' } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('FormData', class { append() {} })
    const fd = new (globalThis as unknown as { FormData: new () => FormData }).FormData()
    const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
    expect(r.success).toBe(true)
    expect(r.data?.url).toBe('/a.png')
  })
})

describe('普通 JSON 请求不受影响', () => {
  it('仍然带 JSON Content-Type', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ success: true, data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('FormData', class { append() {} })
    await apiFetch('/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})

describe('401 仍然统一跳登录（上传也一样）', () => {
  it('FormData 请求遇到 401 也触发 handle401', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: '未登录' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('FormData', class { append() {} })
    vi.stubGlobal('window', {})
    const fd = new (globalThis as unknown as { FormData: new () => FormData }).FormData()
    await apiFetch('/api/assets', { method: 'POST', body: fd })
    expect(mocks.handle401).toHaveBeenCalledTimes(1)
  })
})
