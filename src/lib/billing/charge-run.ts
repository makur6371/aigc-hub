import { getPrisma } from '@/lib/prisma'
import { randomUUID } from 'crypto'
import { refundPoints, refundBeans, deductRunCharge } from '@/lib/billing/wallet'
import { tryConsumeFreeQuota, releaseFreeQuota } from '@/lib/free-quota'
import { planNodeCharge, resolvePerSecondPoints } from '@/lib/billing/billing-plans'
import { resolveChargeModel } from '@/lib/model-catalog'
import { resolveAvailableBalance } from '@/lib/billing/team'
import { toDetailJson } from '@/lib/usage-detail'
import { activeDiscount } from '@/lib/pricing'
import { outputKindFromModelType } from '@/lib/media-kinds'
import { decodeSize, resolveImageSizeForModel } from '@/lib/image-sizes'
import { DRAIN_MESSAGE, isDraining } from '@/lib/drain'
import { consumeFreeImagePass, releaseFreeImagePass } from '@/lib/promotions/free-image-pass'

/**
 * 统一「一次模型调用」的完整事务
 *
 * 为什么存在：原先 image/generate、image/batch-edit、audio/generate、
 * video/generate 等路由各自手写同一段编排（解析模型 → 取免费额度 → 预扣 → 执行 →
 * 失败退款 → 写记录），导致三个真实问题：
 *   1) 口径漂移：upscale 曾多包一层 effectivePoints 造成「折扣两次」，靠注释才没再犯；
 *   2) 回滚不一致：有的路由 .catch(() => {}) 吞掉额度回滚失败，用户额度白扣；
 *   3) 调用日志缺失：多数路由不写 apiUsageLog，运维面板看不到调用详情。
 *
 * 现在收敛为唯一实现：调用方只描述「用哪个模型、算什么价、执行什么」，
 * 额度/扣费/退款/日志一律由这里负责。
 *
 * 用法：
 *   const run = await chargeRun.start({ userId, modelType: 'IMAGE', modelId, width, height, source: 'api' })
 *   try {
 *     const out = await run.execute(() => invokeImage(...))
 *     await run.settle({ nodeLabel: '高清放大', response: { url: out.imageUrl } })
 *   } catch (err) {
 *     await run.fail(err)   // 自动退款 + 归还额度 + 写失败日志
 *   }
 */

const CURRENCY = { points: 'points', beans: 'beans' } as const

export interface ChargeRunStartInput {
  userId: string
  /** 需要哪种能力的模型；用于选中/回退 */
  modelType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'VISION'
  /** 指定模型 ID；失效时按类型回退到可用模型 */
  modelId?: string
  /** 计费口径所需的档位信息（仅 IMAGE 用） */
  width?: number
  height?: number
  /** 音频按秒计价时的时长 */
  durationSec?: number
  /**
   * 同一次调用要产出的份数（默认 1）。
   * 用于「一次预扣、批量产出」的调用方（如 Agent 一次生成 N 张图），
   * 计价按单份价 × count，退款时整体退回未产出部分。
   */
  count?: number
  /** 视频计费因子：输入的参考图张数（按输入素材计费时用） */
  imageCount?: number
  /** 视频计费因子：输出分辨率档（canonical，如 768P）；用于按档位定价 */
  resolution?: string
  /** 调用来源标签，写入 apiUsageLog.source（tool / canvas / copilot / agent / api） */
  source?: string
  /** 所属执行任务（CanvasRun.id / GenerationTask.id），便于流水串联；
   *  不传时 chargeRun 自己生成一个，保证任何调用方的扣费流水都可追溯（见下方 runId） */
  runId?: string
}

export interface ChargedRun {
  model: {
    id: string
    name: string
    modelName: string
    /** 模型能力类型（IMAGE / VIDEO / AUDIO / TEXT / VISION）；调用方按类型分支时用它，无需再查一次库 */
    type: string
    providerId: string
    baseUrl: string
    apiKey: string
    adapterId: string | null
    configJson: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
    costPoints: number
    isFree: boolean
    supportsVision: boolean
  }
  /** 本次实际扣费（命中免费额度时为 0） */
  cost: { points: number; beans: number }
  /** 是否命中了每日免费额度（命中时不扣费，且失败要归还） */
  usedFreeQuota: boolean
  /** IMAGE 实际计费/调用尺寸（已按 metadata.sizes 吸附；未指定尺寸时为 null） */
  imageSize: { width: number; height: number } | null
  /**
   * 本次计费的事务号：调用方传入值，或 chargeRun 兜底生成的 uuid。
   * pointsLog / beansLog / apiUsageLog 写的是同一个值，
   * 调用方也可以拿它挂到自己的业务记录上（record.runId）。
   */
  runId: string
  /** 执行任务体；把真正的上游调用包在这里，成功/失败都走 settle/fail 收口 */
  execute: <T,>(fn: () => Promise<T>) => Promise<T>
  /** 成功收口：写调用日志（含请求/响应详情、耗时、token 用量） */
  settle: (meta?: { nodeLabel?: string; request?: unknown; response?: unknown; statusCode?: number; usage?: { totalTokens?: number | null } | null }) => Promise<void>
  /** 失败收口：退款 + 归还额度 + 写失败日志。返回给调用方用于构造响应 */
  fail: (err: unknown, meta?: { nodeLabel?: string; request?: unknown }) => Promise<string>
  /**
   * 异步任务收口：上游只返回 taskId，真正的成功/失败在轮询阶段才知道。
   * 此时**不能** settle（钱已扣、日志要等真正结果），交给对应的 status 轮询接口处理。
   * 调用后本 run 视为「已交出控制权」，settle/fail 不再生效。
   */
  defer: (meta?: { nodeLabel?: string; request?: unknown; taskId?: string; recordIds?: string[] }) => Promise<void>
}

export class ChargeRunError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * 开始一次计费调用。返回前已完成：模型解析 + 免费额度占用 + 预扣。
 * 任一前置校验失败会 throw ChargeRunError（带 HTTP 状态码，调用方直接透传）。
 */
export async function chargeRun(input: ChargeRunStartInput): Promise<ChargedRun> {
  // 优雅停机闸门（Q-D62）：容器正在排空时，**新来的**生成请求立刻失败。
  //
  // 为什么拦在这里而不是每个路由入口：13 个生成入口（image/video/audio/agent/
  // 而且拦在**扣钱之前** —— 不会出现「钱扣了、任务被拒」的脏状态。
  //
  // 为什么需要它：Docker 默认只给 10 秒 stop_grace_period，而生图超时是 15 分钟。
  // 若不拦，用户会在停机窗口里接到一个「接受、然后 10 秒后被 SIGKILL」的生成任务 ——
  // 白等几分钟、最后失败。明确告知「服务正在发布，请稍后重试」要诚实得多。
  if (isDraining()) {
    throw new ChargeRunError(DRAIN_MESSAGE, 503)
  }

  const prisma = await getPrisma()

  /**
   * 计费事务号：调用方给了就用（画布 CanvasRun.id、Agent GenerationTask.id），
   * 没给就自己生成一个 —— 而不是留 null。
   *
   * 为什么在库里生成、而不是去改 11 个直连调用方（Q-D09 的前置）：
   * pointsLog / beansLog / apiUsageLog 三处**都由本函数写**，只要这里有一个号，
   * 「这笔扣费有没有对应的成功调用」就能查；而孤儿扣费审计（见
   * docs/OPTIMIZATION_PLAN-2026-11.md 生产体检一节）此前正因为直连路径 runId 全空，
   * 完全测不出真实暴露（30 天 13 笔扣费无从关联）。调用方后续要把号挂到自己的
   * 业务记录上时，读 `run.runId` 即可。
   */
  const runId = (typeof input.runId === 'string' && input.runId.trim()) || randomUUID()

  // ---- 1. 用户 ----
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, points: true, beans: true, subscriptionExpiryAt: true, freeImageUntil: true },
  })
  if (!user) throw new ChargeRunError('用户不存在', 404)
  // ---- 2. 模型解析（指定失效时按类型回退）----
  const resolved = await resolveChargeModel(input.modelType, input.modelId)
  if (!resolved) {
    throw new ChargeRunError('没有可用的模型，请在系统设置中配置', 400)
  }
  const model = await prisma.modelConfig.findUnique({
    where: { id: resolved.id },
    include: { provider: true },
  })
  if (!model || !model.provider) throw new ChargeRunError('模型或供应商不存在', 400)
  if (!model.provider.isActive) throw new ChargeRunError('模型对应的供应商已停用', 400)
  if (!model.provider.apiKey) {
    throw new ChargeRunError(`Provider ${model.provider.baseUrl} 未配置 API Key`, 400)
  }
  // 图片尺寸必须先按模型声明的 sizes 吸附，再计费。
  // 否则直接调用 API/MCP 传 4K，而上游实际只支持 1K 时，会出现“按 4K 扣费、实际出 1K”。
  const resolvedImageSize = input.modelType === 'IMAGE'
    ? resolveImageSizeForModel(
        (model.metadata as Record<string, unknown> | null) ?? null,
        input.width,
        input.height,
      )
    : null

  // ---- 3. 计价（币种由模型类型决定：视频走豆，其余走积分）----
  // 注意 planNodeCharge 对 IMAGE 已内部应用折扣，这里不得再包一层 effectivePoints。
  const billingModel = {
    costPoints: model.costPoints,
    videoCost: model.videoCost,
    discount: activeDiscount(model),
    isFree: model.isFree,
    metadata: (model.metadata as Record<string, unknown> | null) ?? null,
  }
  // AUDIO 若配了 perSecondCost 且给了时长 → 按秒计价（积分）
  const perSecondPoints =
    input.modelType === 'AUDIO' ? resolvePerSecondPoints(billingModel, input.durationSec) : null

  let plan: { points: number; beans: number }
  if (perSecondPoints != null) {
    plan = { points: perSecondPoints, beans: 0 }
  } else {
    // VIDEO 的按秒/一口价现在统一在 planNodeCharge 内决策（与画布实际扣费同口径）：
    //   给了时长 → perSecondBeans × 秒；否则回退 videoCost。
    plan = planNodeCharge(input.modelType, billingModel, {
      width: resolvedImageSize?.width ?? input.width,
      height: resolvedImageSize?.height ?? input.height,
      durationSec: input.durationSec,
      imageCount: input.imageCount,
      resolution: input.resolution,
    })
  }

  // 视频必须要么有豆价、要么显式免费，否则一律视为**配置异常并拒单**。
  //
  // 旧条件带了 `input.durationSec == null` 才校验，于是「按秒计价配了一半」的模型
  // （只配 perSecondByResolution 没配兜底、或分辨率未命中 → 算出 0 豆）在带时长时
  // 完全绕过校验，付费视频静默变成 0 豆 —— 2026-10-15 事故的同一个形状。
  // 现在不分支：只要不是 isFree 且算出 0 豆就拒单，让配置错误在后台暴露，
  // 而不是默默送给用户。
  if (input.modelType === 'VIDEO' && plan.beans <= 0 && !model.isFree) {
    throw new ChargeRunError('该视频模型未配置豆价，请联系管理员', 400)
  }

  // 批量产出：单份价 × 份数
  const units = Math.max(1, Math.floor(input.count ?? 1))
  if (units > 1) plan = { points: plan.points * units, beans: plan.beans * units }

  // 时长券：先占名额并写台账（有效期内还要受「每天最多几张」约束）。
  // 不能只用 isPromoFreeImage 的布尔值 —— 那样后台限不住次数、也算不出用量。
  // 按 units 计名额：一次生成 4 张就消耗 4 张，而不是只算 1 次。
  const pass = await consumeFreeImagePass({
    model: { id: model.id, type: model.type, dailyUserFreeQuota: model.dailyUserFreeQuota },
    user,
    userId: user.id,
    source: input.source ?? 'api',
    runId,
    units,
  })
  const promoFreeImage = pass.free

  // ---- 4. 免费额度（两级：每用户 + 平台）----
  // 档位上限（metadata.freeQuotaMaxTier）：用户选的档位超出免费额度上限时不走免费，
  // 按正常计费。免费额度是按次数算的，但生图成本随档位翻倍 —— 不限制就等于
  // 让用户拿「1K 的额度」白嫖 4K 的上游成本。
  const chargeTier = resolvedImageSize?.tier
    ?? (input.width && input.height ? decodeSize(`${input.width}x${input.height}`)?.tier : undefined)
  const usedFreeQuota = promoFreeImage
    ? false
    : await tryConsumeFreeQuota(
      {
        id: model.id,
        dailyUserFreeQuota: model.dailyUserFreeQuota,
        dailyPlatformFreeQuota: model.dailyPlatformFreeQuota,
        metadata: (model.metadata as Record<string, unknown> | null) ?? null,
      },
      user.id,
      chargeTier,
    )

  const cost = usedFreeQuota || promoFreeImage ? { points: 0, beans: 0 } : plan

  // ---- 5. 余额校验（不足则归还刚占用的额度）----
  // 团队共享池：成员的余额是 0（钱在老板账上），必须按出资人的余额判定，
  // 否则成员走不到扣费就被「积分不足」提前拒掉，团队功能形同虚设。
  const avail = await resolveAvailableBalance(user.id)
  if (cost.points > 0 && avail.points < cost.points) {
    if (usedFreeQuota) await safeReleaseQuota(model.id, user.id)
    await releaseFreeImagePass(pass.usageIds)
    throw new ChargeRunError(avail.isTeam ? `团队积分不足，本次需 ${cost.points} 积分` : `积分不足，本次需 ${cost.points} 积分`, 402)
  }
  if (cost.beans > 0 && avail.beans < cost.beans) {
    if (usedFreeQuota) await safeReleaseQuota(model.id, user.id)
    await releaseFreeImagePass(pass.usageIds)
    throw new ChargeRunError(avail.isTeam ? `团队豆不足，本次需 ${cost.beans} 豆` : `豆不足，本次需 ${cost.beans} 豆`, 402)
  }

  // ---- 6. 预扣 ----
  const description = `${input.source === 'canvas' ? '生成扣费' : '生成扣费'}：${model.name}`
  // 两币种必须在同一事务里扣（Q-D01）：分开调用时豆扣失败会导致已扣积分无退款路径
  // —— throw 后 run 尚未产生，调用方的 run.fail() 无法执行。
  // deductRunCharge 对 0/0 直接返回（会员免费生图不写流水，避免垃圾日志）
  await deductRunCharge({ userId: user.id, points: cost.points, beans: cost.beans, description, runId: runId })

  let settled = false
  let startedAt = Date.now()

  return {
    model: {
      id: model.id,
      name: model.name,
      modelName: model.modelName || model.name,
      type: model.type,
      providerId: model.providerId,
      baseUrl: model.provider.baseUrl,
      apiKey: model.provider.apiKey,
      adapterId: model.provider.adapterId ?? null,
      configJson: (model.provider.configJson as Record<string, unknown> | null) ?? null,
      metadata: (model.metadata as Record<string, unknown> | null) ?? null,
      costPoints: model.costPoints,
      isFree: model.isFree,
      supportsVision: model.supportsVision || model.type === 'VISION',
    },
    cost,
    usedFreeQuota,
    runId,
    imageSize: resolvedImageSize ? { width: resolvedImageSize.width, height: resolvedImageSize.height } : null,
    async execute<T>(fn: () => Promise<T>): Promise<T> {
      startedAt = Date.now()
      return fn()
    },
    async settle(meta) {
      if (settled) return
      settled = true
      const outputKind = outputKindFromModelType(model.type)
      const tokensUsed = meta?.usage?.totalTokens ?? null
      await writeUsageLog({
        userId: user.id,
        modelId: model.id,
        tokensUsed: typeof tokensUsed === 'number' && tokensUsed > 0 ? Math.round(tokensUsed) : null,
        pointsDeducted: cost.points,
        beansDeducted: cost.beans,
        statusCode: meta?.statusCode ?? 200,
        durationMs: Date.now() - startedAt,
        source: input.source ?? 'api',
        nodeLabel: meta?.nodeLabel,
        runId: runId,
        requestJson: toDetailJson(meta?.request ?? null),
        responseJson: toDetailJson(meta?.response ?? null),
        outputKind,
      })
    },
    async defer(meta) {
      if (settled) return
      settled = true
      // 写一条 PENDING 语义的日志：让运维面板能看到「已派发、等上游」
      await writeUsageLog({
        userId: user.id,
        modelId: model.id,
        pointsDeducted: cost.points,
        beansDeducted: cost.beans,
        statusCode: 202,
        durationMs: Date.now() - startedAt,
        source: input.source ?? 'api',
        nodeLabel: meta?.nodeLabel,
        runId: runId,
        requestJson: toDetailJson(meta?.request ?? null),
        responseJson: toDetailJson({ pending: true, recordIds: meta?.recordIds, submissionDurationMs: Date.now() - startedAt, note: '异步任务已派发，结果由轮询接口结算' }),
        outputKind: outputKindFromModelType(model.type),
        // 任务型调用的关键标识：没有它，后台就无法按任务维度查看这次调用
        taskId: meta?.taskId,
        taskProgress: '已提交，等待上游受理',
      }).catch((e) => console.error('[charge-run] 写异步日志出错:', e))
    },
    async fail(err, meta) {
      if (settled) return err instanceof Error ? err.message : '调用失败'
      settled = true
      const message = err instanceof Error ? err.message : '调用失败'

      // 退款与额度归还要各自独立、互不阻断：任一步失败都不能影响另一步，
      // 也不能吞掉真正要返回给用户的错误信息。
      if (cost.points > 0) {
        await refundPoints({ userId: user.id, amount: cost.points, description: '生成失败退款', runId: runId })
          .catch((e) => console.error('[charge-run] 积分退款失败:', e))
      }
      if (cost.beans > 0) {
        await refundBeans({ userId: user.id, amount: cost.beans, description: '生成失败退款', runId: runId })
          .catch((e) => console.error('[charge-run] 豆退款失败:', e))
      }
      if (usedFreeQuota) await safeReleaseQuota(model.id, user.id)
      await releaseFreeImagePass(pass.usageIds)

      await writeUsageLog({
        userId: user.id,
        modelId: model.id,
        pointsDeducted: 0,
        beansDeducted: 0,
        statusCode: 500,
        errorMessage: message,
        durationMs: Date.now() - startedAt,
        source: input.source ?? 'api',
        nodeLabel: meta?.nodeLabel,
        runId: runId,
        requestJson: toDetailJson(meta?.request ?? null),
        responseJson: toDetailJson({ error: message }),
      }).catch((e) => console.error('[charge-run] 写失败日志出错:', e))

      return message
    },
  }
}

/** 归还免费额度：失败只记日志，绝不抛给调用方（回滚不该阻断主流程） */
async function safeReleaseQuota(modelId: string, userId: string): Promise<void> {
  await releaseFreeQuota(modelId, userId).catch((e) =>
    console.error('[charge-run] 免费额度归还失败（需人工核查）:', { modelId, userId, err: e }),
  )
}

async function writeUsageLog(data: {
  userId: string
  modelId: string
  tokensUsed?: number | null
  pointsDeducted: number
  beansDeducted?: number
  statusCode: number
  errorMessage?: string
  durationMs?: number
  source?: string
  nodeLabel?: string
  runId?: string
  requestJson?: string | null
  responseJson?: string | null
  /** 产物模态：写入时刻由模型类型判定，供日志/成果区直读（不再靠前端猜） */
  outputKind?: string | null
  /** 上游异步任务 ID + 进度（任务型调用才有） */
  taskId?: string | null
  taskProgress?: string | null
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.apiUsageLog.create({
    data: {
      userId: data.userId,
      modelId: data.modelId,
      tokensUsed: data.tokensUsed ?? null,
      pointsDeducted: data.pointsDeducted,
      beansDeducted: data.beansDeducted ?? 0,
      statusCode: data.statusCode,
      errorMessage: data.errorMessage ?? null,
      durationMs: data.durationMs ?? null,
      source: data.source ?? null,
      nodeLabel: data.nodeLabel ?? null,
      runId: data.runId ?? null,
      requestJson: data.requestJson ?? null,
      responseJson: data.responseJson ?? null,
      outputKind: data.outputKind ?? null,
      taskId: data.taskId ?? null,
      taskProgress: data.taskProgress ?? null,
    },
  })
}

export const __internals = { CURRENCY }
