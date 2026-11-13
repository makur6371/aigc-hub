import { getPrisma } from '@/lib/prisma'
import { localDayKey } from '@/lib/day-key'
import type { Prisma } from '@prisma/client'

// ===== 全平台每日免费额度 =====
// 两级额度同时生效，任一耗尽即回落到正常计费：
//   1) 每用户每日额度（ModelConfig.dailyUserFreeQuota）
//   2) 该模型全平台每日总额度（ModelConfig.dailyPlatformFreeQuota）
// 每日 0 点（本地日）自然重置：用量按 YYYY-MM-DD 分桶，跨天自动从 0 开始，无需定时任务。

type Tx = Prisma.TransactionClient

export interface FreeQuotaModel {
  id: string
  dailyUserFreeQuota?: number | null
  dailyPlatformFreeQuota?: number | null
  /** 读 freeQuotaMaxTier 用；缺失时按「不限制档位」处理 */
  /** Prisma 的 metadata 是 JsonValue（含数组/标量），这里放宽为 unknown 并在读取处收窄 */
  metadata?: unknown
}

/**
 * 免费额度允许的最大档位（metadata.freeQuotaMaxTier）。
 *
 * ===== 为什么需要（真实资损方向）=====
 * 免费额度是「按次数」计的，但生图**成本随档位翻倍**（tierCost1K/2K/4K）。
 * 原本只有「每用户 10 次 / 平台 300 次」，**没有约束用户用哪一档**：
 * 于是用户可以把 10 次免费额度全部用在 4K 上 —— 平台按 1K 的心理价位准备了额度，
 * 实际付出的是 4K 的上游成本（约 3~5 倍）。
 *
 * 语义：
 *   - 不配（null/空）→ 不限制档位（保持既有行为，老模型不用改配置）
 *   - '1K' → 免费额度只够 1K；用户选 2K/4K 时**不走免费额度**，
 *     按正常计费扣积分（而不是报错 —— 用户有权付费出 4K）
 *   - 档位名与 image-sizes.RES_TIERS 对齐（'1K' | '2K' | '4K'）
 */
export const FREE_QUOTA_MAX_TIER_KEY = 'freeQuotaMaxTier'

/** 读模型声明的免费额度档位上限；未声明返回 null（= 不限制） */
export function resolveFreeQuotaMaxTier(metadata: unknown): string | null {
  // Prisma 的 metadata 是 JsonValue：可能是对象/数组/null/标量，只有对象才取键
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const v = (metadata as Record<string, unknown>)[FREE_QUOTA_MAX_TIER_KEY]
  if (typeof v !== 'string') return null
  const t = v.trim().toUpperCase()
  return t === '' ? null : t
}

/** 档位序（越大越贵）；未知档位按最低档处理，保证「未声明即不放行更高档」 */
const TIER_ORDER: Record<string, number> = { '1K': 1, '2K': 2, '4K': 3 }

/**
 * 本次请求的档位是否在免费额度允许范围内。
 * maxTier 未配置 → 一律放行（不改变既有行为）。
 */
export function isTierFreeQuotaEligible(tier: string | null | undefined, maxTier: string | null): boolean {
  if (!maxTier) return true
  // 请求档位解不出来（未传宽高 / 非标尺寸）→ 按最低档处理，只在上限就是最低档时拒绝
  const want = tier ? (TIER_ORDER[tier.toUpperCase()] ?? 1) : 1
  const cap = TIER_ORDER[maxTier.toUpperCase()] ?? 1
  return want <= cap
}

export interface FreeQuotaStatus {
  /** 该模型是否配置了免费额度 */
  enabled: boolean
  /** 每用户每日上限（0 = 未配置） */
  userLimit: number
  /** 平台每日总上限（0 = 不限） */
  platformLimit: number
  /** 当前用户今日已用次数 */
  userUsed: number
  /** 平台今日已用总次数 */
  platformUsed: number
  /** 当前用户今日剩余可用次数（受两级额度共同约束） */
  remaining: number
}

/** 读取某模型今日免费额度状态（只读，不消耗）。 */
export async function getFreeQuotaStatus(
  model: FreeQuotaModel,
  userId: string,
  /** 本次请求档位；超出 freeQuotaMaxTier 时 remaining 返回 0（前端预估才不会被骗） */
  tier?: string | null,
  tx?: Tx,
): Promise<FreeQuotaStatus> {
  const userLimit = Math.max(0, model.dailyUserFreeQuota ?? 0)
  const platformLimit = Math.max(0, model.dailyPlatformFreeQuota ?? 0)
  if (userLimit <= 0) {
    return { enabled: false, userLimit: 0, platformLimit, userUsed: 0, platformUsed: 0, remaining: 0 }
  }
  const prisma = tx ?? (await getPrisma())
  const day = localDayKey()
  const [mine, platformAgg] = await Promise.all([
    prisma.modelFreeQuotaUsage.findUnique({
      where: { modelId_userId_day: { modelId: model.id, userId, day } },
      select: { count: true },
    }),
    platformLimit > 0
      ? prisma.modelFreeQuotaUsage.aggregate({
          where: { modelId: model.id, day },
          _sum: { count: true },
        })
      : Promise.resolve({ _sum: { count: 0 } }),
  ])
  const userUsed = mine?.count ?? 0
  const platformUsed = platformAgg._sum.count ?? 0
  const byUser = Math.max(0, userLimit - userUsed)
  const byPlatform = platformLimit > 0 ? Math.max(0, platformLimit - platformUsed) : Number.MAX_SAFE_INTEGER
  // 档位超上限：本次不能用免费额度（remaining=0），但已用次数照实返回便于排查
  const tierAllowed = isTierFreeQuotaEligible(tier, resolveFreeQuotaMaxTier(model.metadata))
  return {
    enabled: true,
    userLimit,
    platformLimit,
    userUsed,
    platformUsed,
    remaining: tierAllowed ? Math.min(byUser, byPlatform) : 0,
  }
}

/**
 * 尝试占用一次免费额度（原子）。成功返回 true（本次调用免费，不扣积分/豆）。
 * 两级额度任一耗尽即返回 false，调用方按正常计费处理。
 */
export async function tryConsumeFreeQuota(
  model: FreeQuotaModel,
  userId: string,
  /**
   * 本次请求的清晰度档位（'1K' | '2K' | '4K'）。
   * 配合 `metadata.freeQuotaMaxTier`：档位超出上限时**不占用**免费额度，
   * 交回调用方按正常计费扣积分。
   */
  tier?: string | null,
  tx?: Tx,
): Promise<boolean> {
  const userLimit = Math.max(0, model.dailyUserFreeQuota ?? 0)
  if (userLimit <= 0) return false
  const platformLimit = Math.max(0, model.dailyPlatformFreeQuota ?? 0)
  // 档位超出免费额度上限 → 直接判定为「不免费」，不消耗任何额度。
  // 注意不能抛错：用户仍然可以**付费**出 2K/4K，只是不该白嫖这次免费额度。
  if (!isTierFreeQuotaEligible(tier, resolveFreeQuotaMaxTier(model.metadata))) return false

  const run = async (client: Tx) => {
    const day = localDayKey()
    // 顺序关键（Q-D10）：**先写后读**。以前「先 aggregate 平台总量再 bump 用户行」，
    // 两个并发事务都能读到旧的总量快照、双双通过 → 平台额度小幅超发
    // （read 在 write 之前，事务快照看不到对方随后提交的占用）。
    // 现在用户占位是事务的第一条写语句 —— WAL 下写锁伴随最新快照，
    // 之后的平台总量聚合必然包含所有并发事务已提交的占用。
    // 每用户额度：条件更新，命中行数=0 表示已达上限（或行不存在）
    const bumped = await client.modelFreeQuotaUsage.updateMany({
      where: { modelId: model.id, userId, day, count: { lt: userLimit } },
      data: { count: { increment: 1 } },
    })
    // 首次使用：尝试插入（唯一键冲突说明并发已插入，再走一次条件更新）
    if (bumped.count === 0) {
      try {
        await client.modelFreeQuotaUsage.create({ data: { modelId: model.id, userId, day, count: 1 } })
      } catch {
        const retry = await client.modelFreeQuotaUsage.updateMany({
          where: { modelId: model.id, userId, day, count: { lt: userLimit } },
          data: { count: { increment: 1 } },
        })
        if (retry.count === 0) return false
      }
    }
    // 平台总额度：在已持有写锁的事务里读聚合，超出（含本次占用）则拒绝
    if (platformLimit > 0) {
      const agg = await client.modelFreeQuotaUsage.aggregate({
        where: { modelId: model.id, day },
        _sum: { count: true },
      })
      if ((agg._sum.count ?? 0) > platformLimit) {
        // 同事务补偿退回本次占位，不依赖回滚语义（调用方可能传入外部 tx）
        await client.modelFreeQuotaUsage.updateMany({
          where: { modelId: model.id, userId, day, count: { gt: 0 } },
          data: { count: { decrement: 1 } },
        })
        return false
      }
    }
    return true
  }

  if (tx) return run(tx)
  const prisma = await getPrisma()
  return prisma.$transaction(run)
}

export { localDayKey }

/**
 * 预检估算：按节点顺序模拟「有免费额度的节点先免费」，返回需要真实支付的积分/豆。
 * 只用于「积分是否够用」的前置判断；实际是否命中在执行时原子判定（预扣只会多不会少，结束时退差额）。
 */
export async function estimatePaidCharge(
  items: Array<{
    model: FreeQuotaModel
    points: number
    beans: number
  }>,
  userId: string,
): Promise<{ points: number; beans: number }> {
  const remainCache = new Map<string, number>()
  let points = 0
  let beans = 0
  for (const it of items) {
    const limit = Math.max(0, it.model.dailyUserFreeQuota ?? 0)
    if (limit > 0) {
      let remain = remainCache.get(it.model.id)
      if (remain === undefined) {
        remain = (await getFreeQuotaStatus(it.model, userId)).remaining
        remainCache.set(it.model.id, remain)
      }
      if (remain > 0) {
        remainCache.set(it.model.id, remain - 1)
        continue
      }
    }
    points += it.points
    beans += it.beans
  }
  return { points, beans }
}

/** 释放一次已占用的免费额度（节点执行失败时回滚，避免用户白白损失一次额度）。 */
export async function releaseFreeQuota(modelId: string, userId: string): Promise<void> {
  const prisma = await getPrisma()
  const day = localDayKey()
  await prisma.modelFreeQuotaUsage.updateMany({
    where: { modelId, userId, day, count: { gt: 0 } },
    data: { count: { decrement: 1 } },
  }).catch(() => {})
}
