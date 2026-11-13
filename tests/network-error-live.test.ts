import { describe, it, expect } from 'vitest'
import { createServer } from 'net'
import { toUpstreamError, describeNetworkFailure } from '@/lib/network-error'

// 为什么有这组「真实网络」测试：
// 单元测试里手写的错误对象是我「以为」的形态。用真实 undici 才发现两件事：
//   1) ECONNRESET 带 cause.code，但 "bad port" 只有 cause.message（没有 code）
//   2) 所以只查 code 会漏掉一批真实故障
// 这组测试用真实 socket 造故障，保证提取逻辑跟得上 Node 的实际行为。

/** 起一个收到连接就立刻断开的 TCP server → 客户端拿到 ECONNRESET */
async function withResettingServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const srv = createServer((sock) => { sock.destroy() })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    return await fn('http://127.0.0.1:' + port + '/x')
  } finally {
    srv.close()
  }
}

/**
 * 本地 DNS 是否被代理接管（Clash fake-ip 等）。
 *
 * 为什么要探测：Clash 的 fake-ip 模式会给**不存在的域名**也返回一个假 IP（198.18.0.x），
 * 于是 fetch 走不到真实的 getaddrinfo 失败，而是被代理断开 → 报 ECONNRESET 而非 ENOTFOUND。
 * 这样「ENOTFOUND 用例」在本机永远造不出来，但它在生产（无代理）是真实存在的故障形态
 * —— 实测生产容器里就是 `code=ENOTFOUND / getaddrinfo ENOTFOUND <host>`。
 *
 * 所以这条用例在本机 skip（并打印原因），在有真实 DNS 的环境照常执行；
 * 同时用 `network-error.test.ts` 里的单测锁死「生产形态错误对象」的提取行为，
 * 保证两边都不留空档。
 */
async function isDnsHijacked(): Promise<boolean> {
  const dns = await import('dns')
  return new Promise((resolve) => {
    dns.lookup('no-such-host-abc123.invalid', (err) => resolve(!err))
  })
}

describe('真实 undici 故障 —— 提取逻辑要跟得上 Node 实际行为', () => {
  it('ECONNRESET（连接被重置）：文案可读 + 保留机器码', async () => {
    const err = await withResettingServer(async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(5000) })
      } catch (e) {
        return e
      }
    })
    const wrapped = toUpstreamError(err)
    const detail = describeNetworkFailure(err)
    console.log('[ECONNRESET] 原始:', (err as Error).message, '| code:', detail.code, '| 最终:', wrapped.message)

    expect(wrapped.message).not.toBe('fetch failed')
    // 不断言精确等于 ECONNRESET：server 立刻 destroy socket 时，客户端看到的
    // 可能是 ECONNRESET、ECONNABORTED，也可能退化成 ETIMEDOUT/TIMEOUT ——
    // 取决于网络栈与时序；对端关闭 socket 时 Undici 也可能报告 UND_ERR_SOCKET。
    // 这条用例真正要守的不变量是「连接类故障都能被识别成可读文案 + 保留机器码 + 标记瞬时」，
    // 具体是哪个 code 属于环境差异，硬钉某个值只会让它在不同机器上随机失败。
    expect(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'TIMEOUT', 'EACCES', 'EPIPE', 'UND_ERR_SOCKET']).toContain(detail.code)
    expect(wrapped.message).toContain(detail.code)
    expect(detail.transient).toBe(true)   // 属于「重试可能成功」
  }, 20000)

  it('ENOTFOUND（域名解析失败）：只有 code、无 message 时也能识别', async (ctx) => {
    // 本机 DNS 被代理接管时造不出这个故障（详见 isDnsHijacked 注释），跳过而非误报失败。
    // 生产形态由 tests/network-error.test.ts 的单测覆盖，这里不做无谓的环境妥协。
    if (await isDnsHijacked()) {
      console.log('[ENOTFOUND] 本机 DNS 被代理接管（fake-ip），跳过该用例')
      ctx.skip()
      return
    }
    let err: unknown
    try {
      await fetch('https://no-such-host-abc123.invalid/', { signal: AbortSignal.timeout(8000) })
    } catch (e) {
      err = e
    }
    const wrapped = toUpstreamError(err)
    console.log('[ENOTFOUND] 最终:', wrapped.message)
    expect(wrapped.message).toContain('域名解析失败')
    // 域名问题不是用户能重试解决的，不该标记为瞬时
    expect(describeNetworkFailure(err).transient).toBe(false)
  }, 25000)

  it('非法端口（只有 cause.message="bad port"，没有 code）也能给出可读文案', async () => {
    let err: unknown
    try {
      // 端口 9 被 undici 判定为 bad port，不会真的发起连接
      await fetch('http://127.0.0.1:9/x', { signal: AbortSignal.timeout(4000) })
    } catch (e) {
      err = e
    }
    const wrapped = toUpstreamError(err)
    console.log('[bad port] 最终:', wrapped.message)
    // 这一条正是「只查 code 会漏掉」的形态
    expect(wrapped.message).not.toBe('fetch failed')
    expect(wrapped.message).toContain('上游地址配置有误')
  }, 15000)
})
