import { describe, it, expect } from 'vitest'
import { parseSseChunk, consumeSseStream } from '@/lib/sse'

// 为什么测这个：这是「本站事件流」的唯一解析实现。
//
// 历史问题（Q-103 修正后的真实病灶）：A 组解析原先在 3 处各写一遍，
// 其中 CopilotPanel 没有做残行累积 → 一行 JSON 恰好在 chunk 边界被切断时，
// 那一半被当坏行丢掉，表现为「流式输出偶发丢字」。
//
// 这些用例把边界行为钉死，防止后人改回「直接 split」。
//
// 注意：上游厂商的 OpenAI 兼容流**不走这个函数**（那是 lib/adapters/ 的事），
// 所以这里不需要测 choices/delta 那种形态。

const ev = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}`

describe('parseSseChunk —— 基本解析', () => {
  it('一行一个事件', () => {
    const { events, rest } = parseSseChunk(`${ev({ type: 'nodeStart', nodeId: 'n1' })}\n`)
    expect(events).toEqual([{ type: 'nodeStart', nodeId: 'n1' }])
    expect(rest).toBe('')
  })

  it('多行多事件，按到达顺序', () => {
    const input = [
      ev({ type: 'nodeStart', nodeId: 'a' }),
      ev({ type: 'nodeOutput', nodeId: 'a' }),
      ev({ type: 'done' }),
    ].join('\n') + '\n'
    const { events } = parseSseChunk(input)
    expect(events.map((e) => e.type)).toEqual(['nodeStart', 'nodeOutput', 'done'])
  })

  it('data: 后必须跟空格才认（本站所有接口都这么写）', () => {
    const { events } = parseSseChunk('data:{"type":"x"}\n')
    expect(events).toEqual([])
  })
})

describe('parseSseChunk —— 残行累积（本次修复的核心）', () => {
  it('chunk 结尾的半行必须作为 rest 返回，不能当坏行丢掉', () => {
    const cut = ev({ type: 'nodeOutput', nodeId: 'n1', payload: 'x'.repeat(50) })
    const half = cut.slice(0, 30) // 故意在半路切断
    // 真实场景里 chunk 边界不会替我们补换行
    const { events, rest } = parseSseChunk(half)

    // 这一行本身不完整 → 解析不出来，但**必须**留在 rest 里
    expect(events).toEqual([])
    expect(rest).toBe(half)
  })

  it('把 rest 拼回下一段后能完整解析（模拟跨 chunk 的真实场景）', () => {
    const full = ev({ type: 'nodeOutput', nodeId: 'n1', value: 'hello world' })
    const first = parseSseChunk(full.slice(0, 20))
    expect(first.events).toEqual([])

    const second = parseSseChunk(full.slice(20) + '\n', first.rest)
    expect(second.events).toEqual([{ type: 'nodeOutput', nodeId: 'n1', value: 'hello world' }])
    expect(second.rest).toBe('')
  })

  it('末尾没有换行符时，最后一行留在 rest（流结束时由调用方补解析）', () => {
    const input = ev({ type: 'a' }) + '\n' + ev({ type: 'b' }) // b 没有换行
    const { events, rest } = parseSseChunk(input)
    expect(events).toEqual([{ type: 'a' }])
    expect(rest).toBe(ev({ type: 'b' }))
  })

  it('carry 加上输入后才够一行时也能解析', () => {
    const { events, rest } = parseSseChunk(`{"type":"x"}\n`, 'data: ')
    expect(events).toEqual([{ type: 'x' }])
    expect(rest).toBe('')
  })
})

describe('parseSseChunk —— 容错', () => {
  it('心跳注释行（: 开头）被忽略', () => {
    const input = ': keep-alive\n' + ev({ type: 'done' }) + '\n'
    expect(parseSseChunk(input).events).toEqual([{ type: 'done' }])
  })

  it('空行被忽略', () => {
    expect(parseSseChunk('\n\n' + ev({ type: 'done' }) + '\n').events).toEqual([{ type: 'done' }])
  })

  it('坏 JSON 只丢那一行，不影响其它事件', () => {
    const input = [ev({ type: 'a' }), 'data: {不是JSON', ev({ type: 'b' })].join('\n') + '\n'
    expect(parseSseChunk(input).events.map((e) => e.type)).toEqual(['a', 'b'])
  })

  it('CRLF 也能解析（Windows 代理会带 \\r）', () => {
    expect(parseSseChunk(ev({ type: 'done' }) + '\r\n').events).toEqual([{ type: 'done' }])
  })

  it('空的 data: 行不产生事件', () => {
    expect(parseSseChunk('data: \ndata: \n').events).toEqual([])
  })

  it('非事件的字段行（event:/id:）被忽略', () => {
    const input = 'event: message\nid: 7\n' + ev({ type: 'done' }) + '\n'
    expect(parseSseChunk(input).events).toEqual([{ type: 'done' }])
  })

  it('非对象 JSON（数组/字符串）不会被当成事件抛错', () => {
    // 这些在业务上没有意义，但解析层不应该崩
    const input = 'data: [1,2,3]\ndata: "str"\ndata: 42\n'
    expect(() => parseSseChunk(input)).not.toThrow()
  })
})

describe('consumeSseStream —— 端到端', () => {
  /** 把若干段文本包装成 ReadableStream，模拟逐个 chunk 到达 */
  const streamOf = (chunks: string[]) => {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
  }

  it('逐 chunk 消费，跨 chunk 的半行不丢', async () => {
    const full = [ev({ type: 'a' }), ev({ type: 'b' }), ev({ type: 'done' })].join('\n') + '\n'
    // 故意在最糟糕的位置切：切在一行中间
    const chunks = [full.slice(0, 35), full.slice(35, 60), full.slice(60)]
    const got: string[] = []
    const ok = await consumeSseStream(streamOf(chunks), (e) => got.push(String(e.type)))
    expect(ok).toBe(true)
    expect(got).toEqual(['a', 'b', 'done'])
  })

  it('流结束但最后一帧没有换行时，最后一条不会丢', async () => {
    const chunks = [ev({ type: 'a' }) + '\n' + ev({ type: 'last' })] // 无末尾换行
    const got: string[] = []
    await consumeSseStream(streamOf(chunks), (e) => got.push(String(e.type)))
    expect(got).toEqual(['a', 'last'])
  })

  it('单个 chunk 里塞多个事件', async () => {
    const chunks = [ev({ type: 'a' }) + '\n' + ev({ type: 'b' }) + '\n']
    const got: string[] = []
    await consumeSseStream(streamOf(chunks), (e) => got.push(String(e.type)))
    expect(got).toEqual(['a', 'b'])
  })

  it('已中止的 signal 直接返回 false（不消费）', async () => {
    const ac = new AbortController()
    ac.abort()
    const got: string[] = []
    const ok = await consumeSseStream(streamOf([ev({ type: 'a' }) + '\n']), (e) => got.push(String(e.type)), {
      signal: ac.signal,
    })
    expect(ok).toBe(false)
    expect(got).toEqual([])
  })
})
