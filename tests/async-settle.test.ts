import { describe, it, expect } from 'vitest'
import { readSource } from './helpers/source-guard'

// 异步任务兜底结算的三条铁律（源码级断言，钉死「不能改回不安全的写法」）。
// 事故形状：用户提交异步视频/音频 → 关页面 → 上游最终 FAILED → 无人轮询
//          → record 永远 PENDING → 预扣的豆/积分永远不退回，且不留下任何痕迹。
// 为什么既有兜底覆盖不到：canvasRun 超时收敛只管 RUNNING，billingHold 对账
// 只管「预扣未结算」；这里是「预扣已结算但退款没发生」。
const src = readSource('src/lib/billing/async-settle.ts')

describe('异步任务兜底结算 —— 安全铁律', () => {
  it('铁律1：必须先查上游，绝不能脱离上游状态直接退款', () => {
    // 两处轮询都必须走 query*Status，refund 只能在 status==='FAILED' 分支里
    expect(src).toMatch(/queryVideoStatus\(/)
    expect(src).toMatch(/queryAudioStatus\(/)
    // 退款必须在 FAILED 判定之后
    const failIdx = src.indexOf("status.status === 'FAILED'")
    const refundIdx = src.indexOf('refundBeans({')
    expect(failIdx).toBeGreaterThan(-1)
    expect(refundIdx).toBeGreaterThan(failIdx)
  })

  it('铁律2：状态流转用原子认领（where status=PENDING），防与用户端轮询双退', () => {
    expect(src).toMatch(/videoGenerationRecord\.updateMany\(\{\s*where:\s*\{\s*id:\s*rec\.id,\s*status:\s*'PENDING'/)
    expect(src).toMatch(/audioGenerationRecord\.updateMany\(\{\s*where:\s*\{\s*id:\s*rec\.id,\s*status:\s*'PENDING'/)
    // 认领失败必须直接跳过（说明已被用户端认领并退过了）
    expect(src).toMatch(/if\s*\(claimed\.count\s*===\s*0\)\s*continue/)
    // 事务内（退款分支）是 `return`（跳过后续逻辑），外层（成功分支）是 `continue`
    expect(src.match(/if\s*\(claimed\.count\s*===\s*0\)\s*return/g) ?? []).toHaveLength(2)
    expect(src.match(/if\s*\(claimed\.count\s*===\s*0\)\s*continue/g) ?? []).toHaveLength(2)
  })

  it('铁律3：上游查不动时保持 PENDING，不退款（盲目退钱=资损）', () => {
    expect(src).toMatch(/catch\s*\(e\)\s*\{[\s\S]{0,400}保持 PENDING/)
    // catch 块里不能出现 refund
    const catchBlocks = src.match(/catch\s*\(e\)\s*\{[\s\S]*?\n\s*\}/g) ?? []
    for (const b of catchBlocks) {
      expect(b).not.toMatch(/refundBeans|refundPoints/)
    }
  })

  it('退款与状态流转同事务（不能分两次写）', () => {
    expect(src).toMatch(/prisma\.\$transaction\(async\s*\(tx\)\s*=>\s*\{[\s\S]{0,600}updateMany\([\s\S]{0,400}refund/)
  })

  it('接管前有冷却期（不给正在正常轮询的用户平白加查询）', () => {
    expect(src).toMatch(/TAKEOVER_AFTER_MS\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/)
    expect(src).toMatch(/createdAt:\s*\{\s*lt:\s*cutoff\s*\}/)
  })

  it('只接管带 taskId 的 PENDING（同步任务不该被这里动）', () => {
    expect(src).toMatch(/const taskId = typeof meta\.taskId === 'string' \? meta\.taskId : null/)
    expect(src).toMatch(/if\s*\(!taskId\)\s*continue/)
  })

  it('免费额度归还在事务外（releaseFreeQuota 自带事务，且额度是次数不是钱）', () => {
    expect(src).toMatch(/usedFreeQuota[\s\S]{0,200}releaseFreeQuota/)
  })

  it('维护任务已接入（否则写了也不会跑）', () => {
    const maint = readSource('src/lib/maintenance.ts')
    expect(maint).toMatch(/settleOrphanedAsyncTasks/)
    expect(maint).toMatch(/asyncSettle/)
  })
})
