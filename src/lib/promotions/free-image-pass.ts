import { getPrisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { localDayKey } from '@/lib/day-key'
import {
  hasBonusFreeImage,
  isCampaignFreeImageModel,
  type PromoModelLike,
  type PromoUserLike,
} from './free-image'

/**
 * 生图时长券 = 「有效期 + 有效期内可免费生成的张数上限」。
 *
 * 为什么要有这个文件：时长券以前只校验 freeImageUntil，有效期内**不限次**。
 * 一张 10 天券可以把指定免费模型打到任意次数，后台既限不住、也算不出用量。
 * 这里把「限额判定 + 使用台账」收敛到唯一实现，所有计费入口共用，
 * 避免 API / 工具 / 画布 / Agent 各写一套导致口径漂移。
 */

export interface FreeImagePassPolicy {
  enabled: boolean
  /** 每用户每天上限；0 = 不限 */
  dailyUserLimit: number
  /** 全平台每天上限；0 = 不限 */
  dailyPlatformLimit: number
  modelIds: string[] | null
}

export type PassBlockReason = 'not-entitled' | 'disabled' | 'user-limit' | 'platform-limit'

export interface PassAvailability {
  /** 本次是否能免费 */
  free: boolean
  reason: PassBlockReason | null
  /** 该用户今天已用张数 */
  userUsed: number
  /** 全平台今天已用张数 */
  platformUsed: number
  /** 该用户今天还剩几张（null = 不限） */
  userRemaining: number | null
  /** 全平台今天还剩几张（null = 不限） */
  platformRemaining: number | null
}

const DEFAULT_POLICY: FreeImagePassPolicy = { enabled: true, dailyUserLimit: 0, dailyPlatformLimit: 0, modelIds: null }
const POLICY_TTL_MS = 10_000

let policyCache: { value: FreeImagePassPolicy; at: number } | null = null

/** 后台保存配置后调用，让本进程立刻生效，不用等 TTL。 */
export function clearFreeImagePassPolicyCache(): void {
  policyCache = null
}

function normalizeLimit(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0
}

export async function getFreeImagePassPolicy(): Promise<FreeImagePassPolicy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value
  const prisma = await getPrisma()
  const row = await prisma.freeImagePassPolicy.findUnique({ where: { id: 'primary' } })
  const value: FreeImagePassPolicy = row
    ? {
        enabled: row.enabled !== false,
        dailyUserLimit: normalizeLimit(row.dailyUserLimit),
        dailyPlatformLimit: normalizeLimit(row.dailyPlatformLimit),
        modelIds: Array.isArray(row.modelIds) ? row.modelIds.filter((id): id is string => typeof id === 'string') : null,
      }
    : DEFAULT_POLICY
  policyCache = { value, at: Date.now() }
  return value
}

/**
 * 只读判定：这次生成能不能走时长券（不占名额）。
 * 用于「预估/预检/模型角标」——不能在这里写台账，否则预检一次就消耗一张。
 */
export async function checkFreeImagePass(
  model: PromoModelLike,
  user: PromoUserLike,
  userId: string,
  now: Date = new Date(),
): Promise<PassAvailability> {
  if (model.type !== 'IMAGE' || !hasBonusFreeImage(user, now)) return emptyAvailability('not-entitled')
  const policy = await getFreeImagePassPolicy()
  return readAvailability(model, userId, now, policy)
}

function emptyAvailability(reason: PassBlockReason | null): PassAvailability {
  return { free: false, reason, userUsed: 0, platformUsed: 0, userRemaining: null, platformRemaining: null }
}

export function isPassModelCovered(model: PromoModelLike, policy: FreeImagePassPolicy): boolean {
  return model.type === 'IMAGE' && (policy.modelIds !== null ? !!model.id && policy.modelIds.includes(model.id) : isCampaignFreeImageModel(model))
}

async function readAvailability(model: PromoModelLike, userId: string, now: Date, policy: FreeImagePassPolicy, client?: Prisma.TransactionClient): Promise<PassAvailability> {
  const base: PassAvailability = {
    free: false,
    reason: null,
    userUsed: 0,
    platformUsed: 0,
    userRemaining: null,
    platformRemaining: null,
  }
  if (!isPassModelCovered(model, policy)) {
    return { ...base, reason: 'not-entitled' }
  }
  if (!policy.enabled) return { ...base, reason: 'disabled' }

  // 两个上限都是 0 = 不限次，无需查库（最常见的配置）。
  if (policy.dailyUserLimit === 0 && policy.dailyPlatformLimit === 0) {
    return { ...base, free: true }
  }

  const prisma = client ?? await getPrisma()
  const day = localDayKey(now)
  const [userUsed, platformUsed] = await Promise.all([
    policy.dailyUserLimit > 0
      ? prisma.freeImagePassUsage.count({ where: { userId, day } })
      : Promise.resolve(0),
    policy.dailyPlatformLimit > 0
      ? prisma.freeImagePassUsage.count({ where: { day } })
      : Promise.resolve(0),
  ])
  const userRemaining = policy.dailyUserLimit > 0 ? Math.max(0, policy.dailyUserLimit - userUsed) : null
  const platformRemaining = policy.dailyPlatformLimit > 0 ? Math.max(0, policy.dailyPlatformLimit - platformUsed) : null
  const reason: PassBlockReason | null = userRemaining === 0
    ? 'user-limit'
    : platformRemaining === 0
      ? 'platform-limit'
      : null

  return {
    free: reason === null,
    reason,
    userUsed,
    platformUsed,
    userRemaining,
    platformRemaining,
  }
}

export interface ConsumePassInput {
  model: PromoModelLike & { id?: string }
  user: PromoUserLike
  userId: string
  source?: string
  runId?: string
  now?: Date
  /** 本次一次产出几张（Agent 一次生成 N 张时按 N 张计名额） */
  units?: number
}

export interface ConsumePassResult {
  free: boolean
  reason: PassBlockReason | null
  /** 台账行 id 列表；生成失败时用它回滚 */
  usageIds: string[]
}

export async function consumeFreeImagePass(input: ConsumePassInput): Promise<ConsumePassResult> {
  if (!input.model.id) return { free: false, reason: 'not-entitled', usageIds: [] }
  const now = input.now ?? new Date()
  const units = Math.min(8, Math.max(1, Math.floor(input.units ?? 1)))
  if (!hasBonusFreeImage(input.user, now) || !isPassModelCovered(input.model, await getFreeImagePassPolicy())) {
    return { free: false, reason: 'not-entitled', usageIds: [] }
  }
  const prisma = await getPrisma()
  const day = localDayKey(now)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO free_image_pass_policies (id, enabled, daily_user_limit, daily_platform_limit, updatedAt)
      VALUES ('primary', 1, 0, 0, ${now})
      ON CONFLICT(id) DO UPDATE SET id = excluded.id
    `
    const row = await tx.freeImagePassPolicy.findUniqueOrThrow({ where: { id: 'primary' } })
    const policy: FreeImagePassPolicy = { enabled: row.enabled, dailyUserLimit: row.dailyUserLimit, dailyPlatformLimit: row.dailyPlatformLimit,
      modelIds: Array.isArray(row.modelIds) ? row.modelIds.filter((id): id is string => typeof id === 'string') : null }
    const availability = await readAvailability(input.model, input.userId, now, policy, tx)
    if (!availability.free) return { free: false, reason: availability.reason, usageIds: [] }
    if (availability.userRemaining !== null && availability.userRemaining < units) return { free: false, reason: 'user-limit', usageIds: [] }
    if (availability.platformRemaining !== null && availability.platformRemaining < units) return { free: false, reason: 'platform-limit', usageIds: [] }
    const usageIds: string[] = []
    for (let index = 0; index < units; index++) {
      const usage = await tx.freeImagePassUsage.create({ data: { userId: input.userId, modelId: input.model.id!, day, source: input.source ?? null, runId: input.runId ?? null }, select: { id: true } })
      usageIds.push(usage.id)
    }
    return { free: true, reason: null, usageIds }
  })
}

/** 生成失败时归还名额（删除台账行，统计与限额同时回退）。 */
export async function releaseFreeImagePass(usageIds: string | string[] | null | undefined): Promise<void> {
  const ids = Array.isArray(usageIds) ? usageIds : usageIds ? [usageIds] : []
  if (ids.length === 0) return
  const prisma = await getPrisma()
  await prisma.freeImagePassUsage.deleteMany({ where: { id: { in: ids } } }).catch((e) => {
    console.error('[free-image-pass] 归还时长券名额失败（需人工核查）:', { ids, err: e })
  })
}
