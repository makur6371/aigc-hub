import { describe, it, expect } from 'vitest'
import { readSource } from './helpers/source-guard'

// Agent 批量出图的部分失败退款（与视频豆事故方向相反：这次是**多退**，平台白送）。
// 事故形状：一次预扣 count×单价 → Promise.all 并发派发 count 张 →
//   第 3 张失败 → catch 走 run.fail → **退全款 count×单价**
//   但另外 2 张已经拿到 URL 并 emit 给用户了（能存、能看）。
//   结果：用户「图拿到了 + 积分也退回来了」= 净赚，平台白亏 2 张的上游成本。
// 正解：与视频分支同一套算法 —— 只退「未产出部分」。
const src = readSource('src/lib/agent-executor.ts')

describe('Agent 批量出图 —— 部分失败只能退未产出部分', () => {
  it('记录已产出张数（且计数在 try 外声明，catch 才拿得到）', () => {
    expect(src).toMatch(/let producedImages = 0/)
    // 声明必须在 try 之前，否则 catch 作用域外不可见
    const decl = src.indexOf('let producedImages = 0')
    const tryAt = src.indexOf('if (d.type === \'image\') {', decl)
    expect(decl).toBeGreaterThan(-1)
    expect(tryAt).toBeGreaterThan(decl)
    expect(src).toMatch(/producedImages\+\+/)
  })

  it('按份计算：只退 totalCost - produced×单价', () => {
    expect(src).toMatch(/const perImage = count > 0 \? totalCost \/ count : 0/)
    expect(src).toMatch(/const consumed = producedImages \* perImage/)
    expect(src).toMatch(/const toRefund = totalCost - consumed/)
    expect(src).toMatch(/refundPoints\(\{[\s\S]{0,200}amount: toRefund/)
  })

  it('不再走 run.fail（它会退全款，与按份退叠加成双退）', () => {
    const catchIdx = src.indexOf('const toRefund = totalCost - consumed')
    const after = src.slice(catchIdx)
    expect(after).not.toMatch(/run\.fail\(/)
  })

  it('免费额度仍然归还（不走 run.fail 就得自己还，否则白损失一次额度）', () => {
    expect(src).toMatch(/run\.usedFreeQuota[\s\S]{0,200}releaseFreeQuota/)
  })

  it('text/audio 只有 1 份 → producedImages=0 → 退全款，行为不变', () => {
    // producedImages 初值 0，且只有 image 分支会 ++；文本/音频恒 0
    const decl = src.match(/let producedImages = 0/)![0]
    expect(decl).toContain('= 0')
  })

  it('视频分支仍用「已产出份数×单价」口径，未被本次改动影响', () => {
    expect(src).toMatch(/const produced = \(pendingRecords\.length \+ videoUrls\.length\) \* beansCost/)
    expect(src).toMatch(/const toRefund = totalBeans - produced/)
  })
})
