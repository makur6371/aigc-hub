/**
 * 本站事件流的增量解析器（SSE）。
 *
 * ===== 这个文件服务谁、不服务谁 =====
 *
 * 只服务 **A 组：本站自己的事件流** —— 也就是 `/api/tools/[id]/run`、
 * `/api/canvas/execute`、`/api/canvas/copilot`、`/api/agent/send` 这些接口
 * 吐出来的 `data: {"type":"nodeOutput", ...}` 业务事件。
 *
 * **不服务 B 组：上游厂商的 OpenAI 兼容流**（`data: {"choices":[...]}` + `[DONE]`）。
 * 那一类属于 `lib/adapters/` 的厂商协议适配层，每家格式都不一样（还有裸 JSON、
 * 别的字段名），强行合并会造出一个「什么都能解析但都不准」的函数。
 * 这两组看起来都叫「SSE」，但它们解析的是**两种不同的协议**。
 *
 * ===== 为什么需要它 =====
 *
 * 在这之前，A 组的解析在三处各写了一遍：
 *   - app/(app)/canvas/page.tsx:1979
 *   - components/canvas/CopilotPanel.tsx:488
 *   - stores/useToolRunStore.ts:209
 *
 * 前两处中的 CopilotPanel **没有做残行累积**（直接 chunk.split('\n')），
 * 于是当一行 JSON 恰好在 chunk 边界被切断时，那一半会被当成坏行丢掉 ——
 * 表现为「流式输出偶发丢字」。这类 bug 在改协议时极易引入、极难发现，
 * 所以把解析收敛到唯一实现，并用测试钉死边界行为。
 *
 * ===== 用法 =====
 *
 * ```ts
 * const reader = res.body!.getReader()
 * const decoder = new TextDecoder()
 * let parser = createSseParser()
 *
 * while (true) {
 *   const { done, value } = await reader.read()
 *   if (done) break
 *   const { events, rest } = parser.feed(decoder.decode(value, { stream: true }))
 *   parser = parser.withRest(rest)   // 或者直接用下面的 createSseStream 封装
 *   for (const e of events) handle(e)
 * }
 * ```
 *
 * 为了少写样板，推荐直接用 `consumeSseStream`（见文件末尾）。
 */

/** 一条本站事件流事件的形状（业务字段由各接口自己约定，这里只保证是对象） */
export type SseEvent = Record<string, unknown>

export interface SseFeedResult {
  /** 本次喂入后能完整解析出来的事件（按到达顺序） */
  events: SseEvent[]
  /** 尾部残行：可能是被 chunk 切断的半行，必须留给下一次 feed */
  rest: string
}

/**
 * 把「一段文本」解析成事件 + 残行。
 *
 * 这是纯函数 —— 不持有状态，残行由调用方通过 `rest` 参数传回，
 * 这样它天然可测试，也不会因为闭包状态被复用而出错。
 *
 * 处理规则（对照 SSE 规范与本项目实际用法）：
 *   1. 只认 `data: ` 前缀行（注意 `data:` 后必须有空格 —— 这是本站所有接口的写法）
 *   2. `:` 开头的行是注释/心跳（`api/tools/[id]/run` 每 15 秒发一个），**必须忽略**
 *   3. 空行是事件分隔符，也忽略（本站每行一个事件，不依赖分隔符）
 *   4. JSON 解析失败的行静默跳过（宁可丢一行，也不能让整条流崩掉）
 *   5. **最后一行如果没有换行符结尾，必须当成残行返回** —— 这是修跨 chunk 丢字的关键
 */
export function parseSseChunk(input: string, carry = ''): SseFeedResult {
  const buf = carry + input
  const lines = buf.split('\n')

  // 末段可能是「还没收到换行」的半行。buf 以 \n 结尾时，split 的最后一个元素是 ''
  // （不是半行），这时没有残行需要携带。
  const rest = lines.pop() ?? ''

  const events: SseEvent[] = []
  for (let line of lines) {
    // CRLF：Windows 代理或某些上游会带 \r，不清掉会让 JSON.parse 失败
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.startsWith('data: ')) continue // 含心跳 ':' 行、空行、其它字段
    const payload = line.slice(6)
    if (!payload) continue
    try {
      events.push(JSON.parse(payload) as SseEvent)
    } catch {
      // 坏行（半行 JSON / 上游夹带的非 JSON 文本）→ 跳过，不影响其它事件
    }
  }
  return { events, rest }
}

/**
 * 流式消费一个 Response.body，逐事件回调。
 *
 * 把「读 chunk → 解码 → 解析 → 留残行」这套样板收在一处，
 * 调用方只需要关心事件本身。这也是防止各调用点又写回自己的循环。
 *
 * @returns 正常读完返回 true；被 `signal` 中止返回 false
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let carry = ''

  try {
    for (;;) {
      if (options.signal?.aborted) return false
      const { done, value } = await reader.read()
      if (done) break
      const { events, rest } = parseSseChunk(decoder.decode(value, { stream: true }), carry)
      carry = rest
      for (const event of events) onEvent(event)
    }
    // 流结束时若还有残行（某些服务端不补末尾换行），补解析一次，避免丢掉最后一条
    if (carry) {
      const { events } = parseSseChunk(carry + '\n', '')
      for (const event of events) onEvent(event)
    }
    return true
  } finally {
    // 主动释放：被中止时如果不 cancel，连接会挂到对端超时才释放
    reader.releaseLock()
  }
}
