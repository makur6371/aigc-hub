import { describe, it, expect } from 'vitest'
import { buildConversationContext } from '@/lib/agent-tool-loop'
import { HISTORY_CONTENT_CHARS, HISTORY_SUMMARY_CHARS } from '@/lib/agent-context-window'

/**
 * 会话上下文组装 —— 回归防护。
 *
 * 背景（真实 bug）：工具循环路径上线时把 history 丢了（旧单次规划路径有
 * conversationContext，换循环后 messages 从空数组开始只塞当轮）。
 * 症状：用户说「生成两张海报对比风格」，Agent 反问「主题是什么」。
 */
describe('buildConversationContext —— 会话上下文组装', () => {
  it('倒序取回的消息 → 正序给模型（DB 查的是最近的，展示要按时间序）', () => {
    const out = buildConversationContext('', [
      { role: 'assistant', content: '第二句' },
      { role: 'user', content: '第一句' },
    ])
    expect(out!.recentMessages!.map((m) => m.content)).toEqual(['第一句', '第二句'])
  })

  // 断言**从常量派生**而不是写死数字：这些上限本来就是可调的（2026-10-04 放宽过一次），
  // 写死会让「调参」变成「改测试」，测试反而失去防护意义。
  it('单条超长内容截断到 HISTORY_CONTENT_CHARS（控 token）', () => {
    const out = buildConversationContext('', [{ role: 'user', content: 'x'.repeat(HISTORY_CONTENT_CHARS + 400) }])
    expect(out!.recentMessages![0].content).toHaveLength(HISTORY_CONTENT_CHARS)
  })

  it('摘要超长截断到 HISTORY_SUMMARY_CHARS，且保留尾部（最近的信息更相关）', () => {
    const out = buildConversationContext('a'.repeat(HISTORY_SUMMARY_CHARS + 500) + 'END', [])
    expect(out!.summary).toHaveLength(HISTORY_SUMMARY_CHARS)
    expect(out!.summary!.endsWith('END')).toBe(true)
  })

  it('空内容消息被过滤（否则会给模型一堆空行）', () => {
    const out = buildConversationContext('', [
      { role: 'assistant', content: '   ' },
      { role: 'user', content: null },
      { role: 'user', content: '有内容' },
    ])
    expect(out!.recentMessages).toHaveLength(1)
    expect(out!.recentMessages![0].content).toBe('有内容')
  })

  it('没有摘要也没有消息 → null（不产生空的 conversationContext 占位）', () => {
    expect(buildConversationContext('', [])).toBeNull()
    expect(buildConversationContext(null, [])).toBeNull()
    expect(buildConversationContext('   ', [{ role: 'user', content: '' }])).toBeNull()
  })

  it('只有摘要 / 只有消息，各自都能单独成立', () => {
    const onlySummary = buildConversationContext('之前的约定', [])
    expect(onlySummary).toEqual({ summary: '之前的约定' })
    expect(onlySummary!.recentMessages).toBeUndefined()

    const onlyMsgs = buildConversationContext('', [{ role: 'user', content: '嗨' }])
    expect(onlyMsgs).toEqual({ recentMessages: [{ role: 'user', content: '嗨' }] })
    expect(onlyMsgs!.summary).toBeUndefined()
  })

  // ===== 两条路径同口径（防漂移）=====

  it('上下文窗口参数来自叶子模块，且不引入循环依赖', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const SRC = join(__dirname, '..', 'src', 'lib')
    const leaf = readFileSync(join(SRC, 'agent-context-window.ts'), 'utf8')
    // 叶子模块不得 import 任何业务模块（否则环又回来了）
    expect(leaf).not.toMatch(/^import .*@\/lib\//m)

    // executor 静态 import 了 tool-loop：它取常量必须走叶子模块，
    // 从 tool-loop 取值引用会构成运行时的环。
    const exec = readFileSync(join(SRC, 'agent-executor.ts'), 'utf8')
    const fromToolLoop = /import {[^}]*HISTORY_[^}]*} from '@\/lib\/agent-tool-loop'/
    expect(fromToolLoop.test(exec), 'agent-executor 不应从 agent-tool-loop 取值常量（循环依赖）').toBe(false)
    expect(exec).toContain("@/lib/agent-context-window")
  })

  it('回落路径的窗口与主路径同源（用共享的预算函数，不写死条数/字数）', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const exec = readFileSync(join(__dirname, '..', 'src', 'lib', 'agent-executor.ts'), 'utf8')
    // 旧实现写死 slice(-6) / slice(0,500) / slice(-1500)，
    // 导致「主路径记得住、回落后突然失忆」—— 这类分叉在本项目已踩过一次。
    expect(exec).not.toMatch(/recentMessages: conversation\.slice\(-\d+\)/)
    // 现在窗口按**模型上下文窗口**动态算（不再写死条数），
    // 回落路径必须用与主路径同一对预算函数 —— 换成具体数字反而会漂移。
    expect(exec).toContain('historyMessagesBudgetChars')
    expect(exec).toContain('historySummaryBudgetChars')
    expect(exec).toContain('HISTORY_CONTENT_CHARS')
  })

  // ===== 2026-10-02：拉长记忆 + 让模型看得见自己产出 =====

  it('助手消息带上「本回合产出 N 张图片」（否则模型不知道上一轮出了什么）', () => {
    const out = buildConversationContext('', [
      { role: 'assistant', content: '已生成图片', mediaUrls: JSON.stringify(['a.png', 'b.png', 'c.png']), mediaType: 'image' },
    ])
    expect(out!.recentMessages![0].produced).toBe('本回合产出 3 张图片')
  })

  it('视频产物按类型表述', () => {
    const out = buildConversationContext('', [
      { role: 'assistant', content: '已生成视频', mediaUrls: JSON.stringify(['v.mp4']), mediaType: 'video' },
    ])
    expect(out!.recentMessages![0].produced).toBe('本回合产出 1 个视频')
  })

  it('用户消息不带 produced（用户不会「产出」）', () => {
    const out = buildConversationContext('', [
      { role: 'user', content: '来两张', mediaUrls: JSON.stringify(['x.png']) },
    ])
    expect(out!.recentMessages![0].produced).toBeUndefined()
  })

  it('mediaUrls 脏数据（非数组 / 非法 JSON / 空数组）不产出 produced，且不抛错', () => {
    for (const bad of ['not-json', '{"a":1}', '[]', JSON.stringify([1, 2, null])]) {
      const out = buildConversationContext('', [
        { role: 'assistant', content: '已生成图片', mediaUrls: bad },
      ])
      expect(out!.recentMessages![0].produced, `bad=${bad}`).toBeUndefined()
    }
  })

  it('历史窗口 >= 12 条（约 6 个来回，覆盖一次完整的多轮改图）', async () => {
    const mod = await import('@/lib/agent-tool-loop')
    expect(mod.HISTORY_MESSAGES).toBeGreaterThanOrEqual(12)
  })

  it('落库摘要比注入模型的更长（存得比给的多，早期内容才找得回来）', async () => {
    const mod = await import('@/lib/agent-tool-loop')
    expect(mod.HISTORY_SUMMARY_STORE_CHARS).toBeGreaterThan(mod.HISTORY_SUMMARY_CHARS)
  })

  it('不修改传入数组（reverse 用副本，调用方数据不被就地翻转）', () => {
    const input = [
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'A' },
    ]
    buildConversationContext('', input)
    expect(input.map((m) => m.content)).toEqual(['B', 'A'])
  })
})
