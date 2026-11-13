import { describe, it, expect } from 'vitest'
import {
  isNetworkFailure,
  describeNetworkFailure,
  withNetworkCode,
  toUpstreamError,
} from '@/lib/network-error'

// 为什么测这个：undici 在连接层失败时只给一句 "fetch failed"，
// 真实原因在 err.cause 里。以前我们直接 throw err，
// 于是运维面板只能看到「fetch failed」，无法区分 DNS/重置/超时
// （2026-09-19 那次故障排查只能靠翻 nginx 日志反推）。
//
// 这些用例钉死「cause 提取 + 中文翻译 + 机器码保留」三件事。

/** 造一个 undici 风格的错误：message 是通用文案，cause 带真实码 */
const undiciErr = (code?: string, message = 'fetch failed') => {
  const e = new Error(message) as Error & { cause?: unknown }
  if (code) e.cause = Object.assign(new Error('inner'), { code })
  return e
}

describe('isNetworkFailure —— 区分网络故障与上游业务错误', () => {
  it('裸 fetch failed 算网络故障', () => {
    expect(isNetworkFailure(new Error('fetch failed'))).toBe(true)
  })

  it('带 cause.code 的算网络故障', () => {
    expect(isNetworkFailure(undiciErr('ECONNRESET'))).toBe(true)
  })

  it('terminated（连接被切断）算网络故障', () => {
    expect(isNetworkFailure(new Error('terminated'))).toBe(true)
  })

  it('上游业务错误不算（不能被误判）', () => {
    expect(isNetworkFailure(new Error('上游返回错误 (400): 内容审核未通过'))).toBe(false)
    expect(isNetworkFailure(new Error('请求频率过高，请稍后重试'))).toBe(false)
    expect(isNetworkFailure(new Error('图片生成超时（480s 未返回）'))).toBe(false)
    expect(isNetworkFailure(new Error('积分不足'))).toBe(false)
  })

  it('非 Error 输入不算', () => {
    expect(isNetworkFailure('fetch failed')).toBe(false)
    expect(isNetworkFailure(null)).toBe(false)
  })
})

describe('describeNetworkFailure —— cause 提取与翻译', () => {
  it('ECONNRESET → 中文 + 保留码 + 标记为瞬时', () => {
    const r = describeNetworkFailure(undiciErr('ECONNRESET'))
    expect(r.code).toBe('ECONNRESET')
    expect(r.userMessage).toBe('网络连接中断，请重试')
    expect(r.transient).toBe(true)
  })

  it('ENOTFOUND → 提示是服务端网络问题（不是用户的错）', () => {
    const r = describeNetworkFailure(undiciErr('ENOTFOUND'))
    expect(r.userMessage).toContain('域名解析失败')
    expect(r.transient).toBe(false)
  })

  // 生产实测形态（2026-09-25 于生产容器执行 fetch("https://<不存在域名>/") 得到）：
  //   message: "fetch failed"
  //   cause:   { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND <host>' }
  // 注意 cause 同时带 code 与 message，且 message 也命中 MESSAGE_RULES —— 两条路都要对。
  // （test/network-error-live.test.ts 那条真实网络用例在 DNS 被代理接管的环境会 skip，
  //   这条单测确保生产形态永远有覆盖。）
  it('ENOTFOUND 生产形态（code + getaddrinfo message 同时存在）', () => {
    const e = new Error('fetch failed') as Error & { cause?: unknown }
    e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND' })

    expect(isNetworkFailure(e)).toBe(true)
    const r = describeNetworkFailure(e)
    expect(r.code).toBe('ENOTFOUND')
    expect(r.userMessage).toContain('域名解析失败')
    expect(r.transient).toBe(false)          // 不是重试能解决的

    const wrapped = toUpstreamError(e)
    expect(wrapped.message).not.toBe('fetch failed')
    expect(wrapped.message).toContain('域名解析失败')
  })

  it('ECONNRESET 生产形态（TLS 未建立即断开）', () => {
    const e = new Error('fetch failed') as Error & { cause?: unknown }
    e.cause = Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' },
    )
    const r = describeNetworkFailure(e)
    expect(r.code).toBe('ECONNRESET')
    expect(r.transient).toBe(true)
  })

  it('ETIMEDOUT → 超时文案', () => {
    expect(describeNetworkFailure(undiciErr('ETIMEDOUT')).userMessage).toContain('超时')
  })

  it('嵌套两层 cause 也能挖出来（undici 有时套 AggregateError）', () => {
    const outer = new Error('fetch failed') as Error & { cause?: unknown }
    outer.cause = { cause: { code: 'ECONNRESET' } }
    expect(describeNetworkFailure(outer).code).toBe('ECONNRESET')
  })

  it('未知码：保留码，但不泄露技术细节给用户', () => {
    const r = describeNetworkFailure(undiciErr('SOME_NEW_CODE'))
    expect(r.code).toBe('SOME_NEW_CODE')
    expect(r.userMessage).toBe('网络异常，请稍后重试')
  })

  it('没有码时回退到原 message（不吞掉信息）', () => {
    expect(describeNetworkFailure(new Error('某种未知错误')).userMessage).toBe('某种未知错误')
  })

  it('cause 成环不会死循环', () => {
    const a = new Error('fetch failed') as Error & { cause?: unknown }
    a.cause = a
    expect(() => describeNetworkFailure(a)).not.toThrow()
  })
})

describe('withNetworkCode —— 机器码拼在中文后面', () => {
  it('码附在末尾，中文在前（用户仍能读懂）', () => {
    expect(withNetworkCode('网络连接中断，请重试', 'ECONNRESET')).toBe('网络连接中断，请重试 (ECONNRESET)')
  })

  it('没有码时不加括号', () => {
    expect(withNetworkCode('网络异常', undefined)).toBe('网络异常')
  })

  it('重复的码不叠加', () => {
    const s = '网络连接中断，请重试 (ECONNRESET)'
    expect(withNetworkCode(s, 'ECONNRESET')).toBe(s)
  })
})

describe('toUpstreamError —— 统一包装', () => {
  it('网络错误被包装成中文 + 码', () => {
    const e = toUpstreamError(undiciErr('ECONNRESET'))
    expect(e.message).toBe('网络连接中断，请重试 (ECONNRESET)')
  })

  it('上游业务错误原样透传（不改变既有行为）', () => {
    const original = new Error('上游返回错误 (400): 内容审核未通过')
    expect(toUpstreamError(original)).toBe(original)
  })

  it('非 Error 输入也能安全包装', () => {
    const e = toUpstreamError({ weird: true })
    expect(e).toBeInstanceOf(Error)
  })
})

describe('Node 20 / Node 24 的报错形态差异（生产是 Node 20，本地是 Node 24）', () => {
  // 为什么单测这两个形态：生产容器实测（2026-09-19）发现
  // Node 20 与 Node 24 在超时/abort 上的文案不同，而且 undici 在
  // connectECONNRESET 时会反复重试直到我们自己的超时兜底 ——
  // 最终抛出的其实是 abort 错误（英文），必须翻译，否则直接漏给用户。

  it('TimeoutError（超时）→ 中文，且算网络故障', () => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    expect(isNetworkFailure(e)).toBe(true)
    const r = describeNetworkFailure(e)
    expect(r.userMessage).toBe('连接超时，请稍后重试')
    expect(r.transient).toBe(true)
    expect(toUpstreamError(e).message).not.toContain('aborted')
  })

  it('AbortError（连接被中断）→ 中文，且算网络故障', () => {
    const e = new Error('This operation was aborted')
    e.name = 'AbortError'
    expect(isNetworkFailure(e)).toBe(true)
    const r = describeNetworkFailure(e)
    expect(r.userMessage).toContain('中断')
    expect(r.transient).toBe(true)
  })

  it('name=TimeoutError 但没有 code/cause 也能识别', () => {
    const e = new Error('随便什么文案') as Error & { name: string }
    e.name = 'TimeoutError'
    expect(describeNetworkFailure(e).userMessage).toContain('超时')
  })
})
