// 解析含多套语块的 JSON，兼容数组 / 含最长数组属性的对象，按字段提取每个语块
//
// 这条链路是「LLM 节点 → json-prompt-batch」的必经之路，模型的三种常见输出都要吃下：
//   1. 纯 JSON（数组 / 含最长数组属性的对象）
//   2. 包在 ```json 代码块里（模型很爱这么干；不兼容会让整条提示词退化成按行拆分）
//   3. 前后多了一句解释，JSON 本体仍是完整配对的 [] 或 {}
// 三者都解析不出时才退回按行拆分。

/** 去掉 Markdown 代码块围栏（与 lib/agent-plan、lib/copilot-actions 同款口径） */
function stripCodeFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fence ? fence[1].trim() : text
}

/** 从混杂文本里截出第一段配平的 JSON 数组/对象（跳过字符串内的括号） */
function extractJsonBody(text: string): string | null {
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const start = text.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }
  return null
}

function tryParseJson(text: string): unknown {
  const candidates = [text, stripCodeFence(text)]
  const body = extractJsonBody(text)
  if (body) candidates.push(body)
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // 换下一种写法继续尝试
    }
  }
  return undefined
}

export function parsePromptBlocks(raw: unknown, field = 'prompt'): { blocks: unknown[]; values: unknown[] } {
  const text = String(raw ?? '').trim()
  if (!text) return { blocks: [], values: [] }

  let blocks: unknown[] = []
  const data = tryParseJson(text)
  if (data === undefined) {
    // JSON 解析失败时按换行拆分
    blocks = text.split('\n').filter((l) => l.trim())
  } else if (Array.isArray(data)) {
    blocks = data
  } else if (data && typeof data === 'object') {
    // 万能解析：找对象中最长的数组属性（不管叫 items/data/results/images...）
    let bestKey: string | null = null
    let bestLen = 0
    for (const k of Object.keys(data as Record<string, unknown>)) {
      const v = (data as Record<string, unknown>)[k]
      if (Array.isArray(v) && v.length > bestLen) {
        bestKey = k
        bestLen = v.length
      }
    }
    blocks = bestKey ? ((data as Record<string, unknown>)[bestKey] as unknown[]) : [data]
  } else {
    blocks = [data]
  }

  const values = blocks.map((item) => {
    if (item && typeof item === 'object' && field in (item as Record<string, unknown>)) {
      return (item as Record<string, unknown>)[field]
    }
    // 对象里没有目标字段：退化取常见文本键，仍取不到就整体序列化，
    // 免得下游拿到 "[object Object]" 这种静默的垃圾提示词。
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      for (const key of ['prompt', 'text', 'content', 'description', 'value']) {
        if (typeof obj[key] === 'string' && obj[key]) return obj[key]
      }
      return JSON.stringify(item)
    }
    return item
  })

  return { blocks, values }
}
