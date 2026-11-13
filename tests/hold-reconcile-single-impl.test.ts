import { describe, it, expect } from 'vitest'
import { readSource } from './helpers/source-guard'

// 「僵死预扣对账」必须只有一份实现（源码级断言，钉死「不许再手抄第二遍」）。
//
// 事故形状：process crash -> settleHold 没跑 -> billingHold 永久 OPEN -> 预扣的钱蒸发。
// 兜底逻辑原本写了两份：wallet.ts 的 reconcileOpenHolds（用户访问 profile 触发）和
// maintenance.ts 的「僵死 OPEN hold 兜底」（定时维护触发）。文案一字不差，
// 语义却各自漂移过一轮：
//   1) maintenance 版把 PAUSED 也按未消耗全退 -> 与「暂停退未消耗」路径双退（多退钱）；
//   2) maintenance 版不把僵死 RUNNING 标 FAILED -> run 永远挂在「运行中」，用户等不到结果；
//   3) wallet 版 run 不存在时永久跳过 -> retention 删了终态 run 后那笔预扣再也退不回来。
// 三处都是「错了没人喊」：余额悄悄变动，没有报错、没有日志、只有对账时才发现。
const wallet = readSource('src/lib/billing/wallet.ts')
const maintenance = readSource('src/lib/maintenance.ts')

describe('僵死预扣对账 —— 唯一实现', () => {
  it('wallet.ts 导出可复用的单条对账 reconcileHold', () => {
    expect(wallet).toMatch(/export async function reconcileHold\(/)
  })

  it('maintenance.ts 直接调用 reconcileHold，不再手写退款事务', () => {
    expect(maintenance).toMatch(/await reconcileHold\(hold\)/)
    // 退款 SQL 与流水只能出现在 wallet.ts
    expect(maintenance).not.toMatch(/UPDATE users SET points = ROUND/)
    expect(maintenance).not.toMatch(/pointsLog\.create/)
    expect(maintenance).not.toMatch(/beansLog\.create/)
  })

  it('reconcileOpenHolds 也走同一实现（两个入口同一口径）', () => {
    const start = wallet.indexOf('export async function reconcileOpenHolds')
    const body = wallet.slice(start, wallet.indexOf('export async function adjustPoints', start))
    expect(body).toMatch(/await reconcileHold\(hold\)/)
    expect(body).not.toMatch(/UPDATE users SET/)
    expect(body).not.toMatch(/pointsLog\.create/)
    expect(body).not.toMatch(/\$transaction/)
  })

  it('PAUSED 必须跳过：暂停路径已退过未消耗部分，双退=资损', () => {
    const fn = wallet.slice(wallet.indexOf('export async function reconcileHold'), wallet.indexOf('export async function reconcileOpenHolds'))
    expect(fn).toMatch(/run\.status === 'PAUSED'/)
    // 跳过条件必须同时覆盖 RUNNING 与 PAUSED，且只在「未僵死」时生效
    expect(fn).toMatch(/\(run\.status === 'RUNNING' \|\| run\.status === 'PAUSED'\) && !stale/)
  })

  it('僵死 RUNNING 要接管退款，并把 run 标 FAILED（否则永远挂在运行中）', () => {
    const fn = wallet.slice(wallet.indexOf('export async function reconcileHold'), wallet.indexOf('export async function reconcileOpenHolds'))
    expect(fn).toMatch(/STALE_RUN_MS/)
    expect(fn).toMatch(/status: 'FAILED', error: '任务中断（服务重启或异常退出），预扣已退回'/)
  })

  it('run 不存在（被 retention 清理）按未消耗全退，不永久跳过', () => {
    const fn = wallet.slice(wallet.indexOf('export async function reconcileHold'), wallet.indexOf('export async function reconcileOpenHolds'))
    expect(fn).toMatch(/const stale = run \? now - run\.updatedAt\.getTime\(\) > STALE_RUN_MS : true/)
    expect(fn).toMatch(/!run \|\| run\.status === 'RUNNING' \? 0/)
    // 不许回到 `if (!run) return` 这种漏退写法
    expect(fn).not.toMatch(/if \(!run\)/)
  })

  it('退款退给出资账号：团队预扣退回团队池，不退给成员个人', () => {
    const fn = wallet.slice(wallet.indexOf('export async function reconcileHold'), wallet.indexOf('export async function reconcileOpenHolds'))
    expect(fn).toMatch(/refundOwnerId = options\?\.refundOwnerId \?\? hold\.billingOwnerId \?\? hold\.userId/)
  })

  it('事务内先原子认领 hold（status=OPEN）再退款，防与用户端轮询双退', () => {
    const fn = wallet.slice(wallet.indexOf('export async function reconcileHold'), wallet.indexOf('export async function reconcileOpenHolds'))
    expect(fn).toMatch(/tx\.billingHold\.findUnique\(\{ where: \{ id: hold\.id \}, select: \{ status: true \} \}\)/)
    expect(fn).toMatch(/if \(!cur \|\| cur\.status !== 'OPEN'\) return/)
  })
})
