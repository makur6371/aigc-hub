import { describe, it, expect } from 'vitest'
import { parsePromptBlocks } from '../src/lib/json-blocks'

// LLM 节点 → json-prompt-batch 的解析契约：模型输出必须被稳定切成 N 条提示词，
// 一旦解析退化成「按行拆分」，下游 19 个生图节点会拿到整段 JSON 文本或空串。
describe('parsePromptBlocks', () => {
  it('纯 JSON 数组按字段取值', () => {
    const raw = JSON.stringify([{ prompt: 'a' }, { prompt: 'b' }])
    expect(parsePromptBlocks(raw).values).toEqual(['a', 'b'])
  })

  it('字符串数组原样返回（图片/URL 场景）', () => {
    expect(parsePromptBlocks(JSON.stringify(['u1', 'u2'])).values).toEqual(['u1', 'u2'])
  })

  it('包裹 ```json 代码块也能解析（不退回按行拆分）', () => {
    const raw = '```json\n[{"prompt":"a"},{"prompt":"b"},{"prompt":"c"}]\n```'
    const { values, blocks } = parsePromptBlocks(raw)
    expect(blocks).toHaveLength(3)
    expect(values).toEqual(['a', 'b', 'c'])
  })

  it('前后带一句解释文字也能截出 JSON 本体', () => {
    const raw = '好的，这是 3 条提示词：\n[{"prompt":"a"},{"prompt":"b"},{"prompt":"c"}]\n希望对你有帮助。'
    expect(parsePromptBlocks(raw).values).toEqual(['a', 'b', 'c'])
  })

  it('字段名不同也能取到文本（不产出 [object Object]）', () => {
    const raw = JSON.stringify([{ text: 'a' }, { content: 'b' }])
    expect(parsePromptBlocks(raw).values).toEqual(['a', 'b'])
  })

  it('对象里既没有目标字段也没有常见文本键时整体序列化', () => {
    const raw = JSON.stringify([{ foo: 1 }])
    expect(parsePromptBlocks(raw).values).toEqual(['{"foo":1}'])
  })

  it('含最长数组属性的对象取最长数组', () => {
    const raw = JSON.stringify({ note: 'x', items: [{ prompt: 'a' }, { prompt: 'b' }] })
    expect(parsePromptBlocks(raw).values).toEqual(['a', 'b'])
  })

  it('提示词里含中括号/花括号不会被误截断', () => {
    const raw = '说明：\n[{"prompt":"画面里有 [标签] 和 {括号}"},{"prompt":"b"}]\n'
    expect(parsePromptBlocks(raw).values).toEqual(['画面里有 [标签] 和 {括号}', 'b'])
  })

  it('彻底不是 JSON 时退回按行拆分（保持历史行为）', () => {
    expect(parsePromptBlocks('第一行\n第二行').values).toEqual(['第一行', '第二行'])
  })

  it('空输入返回空数组', () => {
    expect(parsePromptBlocks('').values).toEqual([])
    expect(parsePromptBlocks(null).values).toEqual([])
  })
})
