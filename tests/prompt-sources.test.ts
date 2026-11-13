import { describe, it, expect } from 'vitest'
import { normalizePromptItems, mirrorCandidates, categoryOf, slugOf } from '@/lib/prompt-sources'

/**
 * 提示词源归一化：错一条就少一条提示词（或把脏数据写进库），
 * 是「算错就有代价」的纯函数，必须有回归网。
 */

const BASE = 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/youmind-nano-banana-pro.json'

describe('normalizePromptItems', () => {
  it('保留合法条目、跳过缺 title/prompt 的脏条目', () => {
    const items = normalizePromptItems(
      [
        { id: 'a', title: '标题', prompt: '内容' },
        { title: '无内容', prompt: '' },
        { id: 'b', prompt: '无标题' },
      ],
      BASE
    )
    expect(items).toHaveLength(1)
    expect(items[0].externalId).toBe('a')
  })

  it('缺 id 时用「源 slug-序号」补稳定 ID，保证二次拉取是 update 而不是重复 insert', () => {
    const items = normalizePromptItems([{ title: 'T', prompt: 'P' }], BASE)
    expect(items[0].externalId).toBe('youmind-nano-banana-pro-0001')
  })

  it('同源内重复 id 只保留第一次', () => {
    const items = normalizePromptItems(
      [
        { id: 'dup', title: '第一次', prompt: 'P1' },
        { id: 'dup', title: '第二次', prompt: 'P2' },
      ],
      BASE
    )
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('第一次')
  })

  it('相对 coverUrl / sourceUrl 按源地址转绝对路径', () => {
    const items = normalizePromptItems(
      [{ id: 'r', title: 'T', prompt: 'P', coverUrl: './img/a.jpg', sourceUrl: 'posts/1' }],
      BASE
    )
    expect(items[0].coverUrl).toBe('https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/img/a.jpg')
    expect(items[0].sourceUrl).toBe('https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/posts/1')
  })

  it('非数组输入返回空数组（不抛异常）', () => {
    expect(normalizePromptItems({ items: [] }, BASE)).toEqual([])
    expect(normalizePromptItems(null, BASE)).toEqual([])
  })

  it('tags 过滤空白并转字符串', () => {
    const items = normalizePromptItems([{ id: 't', title: 'T', prompt: 'P', tags: ['海报设计', '', 42, '  '] }], BASE)
    expect(items[0].tags).toEqual(['海报设计', '42'])
  })
})

describe('mirrorCandidates', () => {
  it('默认只使用管理员配置的地址', () => {
    const list = mirrorCandidates('https://raw.githubusercontent.com/o/r/main/a.json')
    expect(list[0]).toBe('https://raw.githubusercontent.com/o/r/main/a.json')
    expect(list).toHaveLength(1)
  })

  it('结果去重', () => {
    const list = mirrorCandidates('https://example.com/a.json')
    expect(new Set(list).size).toBe(list.length)
  })
})

describe('categoryOf / slugOf', () => {
  it('分类取第一个非空 tag，回退「通用」', () => {
    expect(categoryOf({ externalId: 'x', title: 'T', prompt: 'P', description: '', coverUrl: '', tags: ['电商商品'], author: '', sourceUrl: '', createdAt: '' })).toBe('电商商品')
    expect(categoryOf({ externalId: 'x', title: 'T', prompt: 'P', description: '', coverUrl: '', tags: [], author: '', sourceUrl: '', createdAt: '' })).toBe('通用')
  })

  it('从注册表 URL 提取源 key', () => {
    expect(slugOf(BASE)).toBe('youmind-nano-banana-pro')
  })
})
