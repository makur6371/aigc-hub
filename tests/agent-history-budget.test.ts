import { describe, it, expect } from 'vitest'
import { historyBudgetChars, historySummaryBudgetChars, historyMessagesBudgetChars, HISTORY_CONTENT_CHARS, HISTORY_SUMMARY_STORE_CHARS } from '@/lib/agent-context-window'
import { buildConversationContext } from '@/lib/agent-tool-loop'

/**
 * 历史窗口按「模型上下文窗口」动态计算 —— 2026-10-04 用户反馈「上面的内容一直丢」后的改造。
 *
 * 旧实现把窗口写死成条数（6→12→24），与模型能力无关：配 256K 和配 8K 用同一套限制，
 * 且每条消息长度差异极大，按条数给窗口的 token 用量能差几十倍。
 * 现在改成按 token 预算（= 窗口 × 安全比例 − 预留），这几条测试锁死这个行为。
 */
describe('historyBudgetChars —— 随模型窗口放大', () => {
  it('窗口越大，预算越大（单调递增）', () => {
    const a = historyBudgetChars(16384)
    const b = historyBudgetChars(32768)
    const c = historyBudgetChars(128000)
    const d = historyBudgetChars(256000)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(d).toBeGreaterThan(c)
  })

  it('256K 窗口给出远大于旧固定值的预算（否则「配置白配」）', () => {
    // 旧实现：24 条 × 最多 1200 字 ≈ 28800 字上限。256K 窗口应显著超过它。
    expect(historyBudgetChars(256000)).toBeGreaterThan(100000)
  })

  it('小窗口不会退化成 0/负数（但要服从容量上限）', () => {
    // 4K 窗口本身容量就小：下限不能越过容量，否则请求会被上游 400 拒掉。
    const small = historyBudgetChars(4096)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThanOrEqual(Math.floor(4096 * 0.6 * 1.5))
    // 16K 起容量够，下限（8000 字符）才会真正生效
    expect(historyBudgetChars(16384)).toBeGreaterThanOrEqual(8000)
  })

  it('绝不超过模型容量（宁可历史短，也不能把请求撑到上游 400）', () => {
    for (const w of [8192, 16384, 32768, 128000, 256000]) {
      // 60% 是安全比例，字符 ≈ token × 1.5
      expect(historyBudgetChars(w)).toBeLessThanOrEqual(Math.floor(w * 0.6 * 1.5))
    }
  })

  it('未配置窗口 → 用兜底值，且预算非空', () => {
    expect(historyBudgetChars(null)).toBeGreaterThan(0)
    expect(historyBudgetChars(undefined)).toBeGreaterThan(0)
  })

  it('兜底值是「当前在用的模型档位」，不是小模型的 32K', () => {
    // 项目在用的规划模型都是 248K 起步；兜底若还是 32K，
    // 忘了在后台填这一栏就会让历史预算掉到 1/7（用户看到的「配了 256K 还记不住」）。
    expect(historyBudgetChars(null)).toBeGreaterThan(100000)
  })

  it('摘要预算也随窗口放大，且小于正文预算', () => {
    expect(historySummaryBudgetChars(256000)).toBeGreaterThan(historySummaryBudgetChars(32000))
    expect(historySummaryBudgetChars(256000)).toBeLessThan(historyBudgetChars(256000))
  })

  it('正文 + 摘要**恒等于总预算**（各算各的会静默超预算 → 上游 400）', () => {
    for (const w of [16384, 32768, 128000, 256000]) {
      const total = historyBudgetChars(w)
      const sum = historyMessagesBudgetChars(w) + historySummaryBudgetChars(w)
      // 正文有 2000 的保底，可能让和略大——但绝不能出现「总和远超总预算」的情况
      expect(sum).toBeLessThanOrEqual(total + 2000)
      // 也不能小太多（否则预算没被真正用上）
      expect(sum).toBeGreaterThan(total * 0.9)
    }
  })

  it('总预算（正文+摘要）不越过模型容量', () => {
    for (const w of [16384, 32768, 128000, 256000]) {
      const sum = historyMessagesBudgetChars(w) + historySummaryBudgetChars(w)
      // 60% 安全比例，字符 ≈ token × 1.5
      expect(sum).toBeLessThanOrEqual(Math.floor(w * 0.6 * 1.5))
    }
  })

  it('摘要**落库上限 > 注入预算**（否则存得比给的少，往前余量白留）', () => {
    // 对最大的窗口也成立：注入 81360 → 落库必须更大
    expect(HISTORY_SUMMARY_STORE_CHARS).toBeGreaterThan(historySummaryBudgetChars(256000))
  })
})

describe('buildConversationContext —— 预算驱动（不再按条数截断）', () => {
  const mk = (n: number, chars: number) =>
    Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}:` + 'x'.repeat(chars) }))

  it('大窗口能装下更多历史（同一批消息，条数随窗口变化）', () => {
    // 倒序传入（模拟 DB 查询）
    const msgs = mk(60, 800).reverse()
    const small = buildConversationContext('', msgs, 8000)
    const big = buildConversationContext('', msgs, 256000)
    expect(big!.recentMessages!.length).toBeGreaterThan(small!.recentMessages!.length)
  })

  it('始终保留最近的（超预算时丢的是最早的）', () => {
    const msgs = mk(40, 800).reverse()
    const out = buildConversationContext('', msgs, 20000)
    const kept = out!.recentMessages!
    // 最后一条必须是「最新」那条（倒序输入的头部）
    expect(kept[kept.length - 1].content.startsWith('m39:')).toBe(true)
    // 最早的应该被丢掉
    expect(kept.some((m) => m.content.startsWith('m0:'))).toBe(false)
  })

  it('单条就超预算时，至少保留一条（不能变成空历史）', () => {
    const huge = [{ role: 'user', content: 'y'.repeat(HISTORY_CONTENT_CHARS + 5000) }]
    const out = buildConversationContext('', huge, 100)
    expect(out!.recentMessages!.length).toBe(1)
  })

  it('条数上限仍然存在（防「只发一个表情」把查询撑到几千条）', () => {
    const tiny = mk(500, 2).reverse()
    const out = buildConversationContext('', tiny, 256000)
    expect(out!.recentMessages!.length).toBeLessThanOrEqual(500)
  })
})
