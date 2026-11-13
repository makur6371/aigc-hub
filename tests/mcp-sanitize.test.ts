import { describe, it, expect } from 'vitest'
import { checkWorkflowSize, findLargeDataUrl, sanitizeForAgent, MAX_WORKFLOW_NODES } from '@/lib/mcp/sanitize'

/**
 * MCP 出入参裁剪 —— 锁死两件容易被静默改坏的事。
 *
 * 1) checkWorkflowSize 的提示必须**可行动**：要带路径 + mime + 体积。
 *    历史坑：这里曾有两个只差大小写的函数（findLargeDataUrl / findLargeDataURL），
 *    checkWorkflowSize 调的是只返回路径的那个 → 用户提示里丢了 mime 和体积，
 *    Agent 拿到「有 base64」却不知道是图还是音频、多大，没法自我修正。
 * 2) sanitizeForAgent 出参截断：base64 dataURL 全量返回会爆 Agent token。
 */

const bigImg = 'data:image/png;base64,' + 'A'.repeat(5000)

describe('checkWorkflowSize —— 拒绝 base64 图时提示要可行动', () => {
  it('带 base64 图 → 提示含路径 + mime + 体积（回归：曾丢失后两者）', () => {
    const msg = checkWorkflowSize([{ id: 'n1', type: 'image-upload', inputs: { images: [bigImg] } }], [])
    expect(msg).toBeTruthy()
    expect(msg).toContain('$.nodes[0].inputs.images[0]')  // 精确路径
    expect(msg).toContain('image')                        // mime 类型
    expect(msg).toContain('5KB')                          // 体积
    expect(msg).toContain('http(s)')                      // 给出替代方案
  })

  it('节点数超限 → 明确告知上限', () => {
    const nodes = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, i) => ({ id: 'n' + i }))
    const msg = checkWorkflowSize(nodes, [])
    expect(msg).toContain('节点数超限')
    expect(msg).toContain(String(MAX_WORKFLOW_NODES))
  })

  it('nodes / connections 非数组 → 明确报哪一项', () => {
    expect(checkWorkflowSize(null, [])).toContain('nodes')
    expect(checkWorkflowSize([], null)).toContain('connections')
  })

  it('干净工作流 → 返回 null（不误拒）', () => {
    expect(checkWorkflowSize([{ id: 'n1', inputs: { prompt: 'hello' } }], [])).toBeNull()
  })

  it('http(s) 图片 URL 不算 base64（不该被拒）', () => {
    const nodes = [{ id: 'n1', inputs: { images: ['https://example.com/a.png'] } }]
    expect(checkWorkflowSize(nodes, [])).toBeNull()
  })

  it('小 dataURL（<2KB）不算大对象（避免误伤图标级内联图）', () => {
    const tiny = 'data:image/png;base64,AAAA'
    expect(checkWorkflowSize([{ id: 'n1', inputs: { images: [tiny] } }], [])).toBeNull()
  })
})

describe('findLargeDataUrl —— 递归查找与描述', () => {
  it('嵌套在对象/数组深处也能定位', () => {
    const hit = findLargeDataUrl({ a: { b: [{ c: bigImg }] } })
    expect(hit).toContain('$.a.b[0].c')
    expect(hit).toContain('image')
  })

  it('无大对象 → null', () => {
    expect(findLargeDataUrl({ a: 'small' })).toBeNull()
  })
})

describe('sanitizeForAgent —— 出参截断（防爆 Agent token）', () => {
  it('大 dataURL 换成摘要对象（不把 base64 原样吐给 Agent）', () => {
    const out = sanitizeForAgent({ images: [bigImg] }) as { images: Record<string, unknown>[] }
    expect(out.images[0]).toMatchObject({ __truncatedDataUrl: true, mime: 'image' })
    expect(String(JSON.stringify(out)).length).toBeLessThan(bigImg.length)
  })

  it('超长普通字符串截断并留预览', () => {
    const long = 'x'.repeat(200 * 1024)
    const out = sanitizeForAgent({ prompt: long }) as { prompt: Record<string, unknown> }
    expect(out.prompt).toMatchObject({ __truncatedString: true })
    expect(String(out.prompt.preview)).toHaveLength(500)
  })

  it('正常小对象原样保留（不误改）', () => {
    const input = { a: 1, b: 'text', c: [true, null] }
    expect(sanitizeForAgent(input)).toEqual(input)
  })
})
