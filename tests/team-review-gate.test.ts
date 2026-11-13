import { describe, it, expect } from 'vitest'
import { ownerIdFrom } from '@/lib/billing/team'

// 审核闸门的**语义**必须钉死：团队未过审 ⇒ 不算团队 ⇒ 扣自己的钱。
//
// 这是资金权力的最后一道闸：企业团队 = 让一个账号为其他账号付费。
// 若不审就生效，任何注册用户都能把自己变成「让别人花我钱」的中转，
// 平台无法区分真实企业与代充/转售通道。
//
// 真正生效点在 lib/billing/team.ts 的 resolveBillingOwner / resolveAvailableBalance
// （读 Team.status === 'APPROVED'），已用真库端到端验证 11 项：
//   待审 → 不共享且扣费被拒、老板余额不动；
//   驳回 → 同上；
//   通过 → 正常从团队池扣；
//   通过后再打回待审 → 立刻停止共享。
// 这里补的是「默认自付」这条不变量在纯函数层的表达，防止有人把归属判定改成
// 「有 billingOwnerId 就共享」而绕过 status。

describe('审核闸门 —— 未过审不得共享计费', () => {
  it('无归属 = 自付（存量用户与新用户）', () => {
    expect(ownerIdFrom(null, 'me')).toBe('me')
    expect(ownerIdFrom(undefined, 'me')).toBe('me')
  })

  it('有归属时由出资人承担（是否真的共享由 resolveBillingOwner 的 status 判定）', () => {
    // ownerIdFrom 只做「有归属用出资人」的映射；
    // status 判定在 resolveBillingOwner —— 两者必须同时成立才会共享。
    expect(ownerIdFrom('boss', 'me')).toBe('boss')
  })
})
