// VOZEB-PRO 借鉴的统一创作 Agent 执行器
// 规划器（上下文注入 + 模型候选 + 计费幂等）→ 依赖并发执行 → 视觉复盘

import { getPrisma } from '@/lib/prisma'
import { HISTORY_MESSAGES, HISTORY_CONTENT_CHARS, historyMessagesBudgetChars, historySummaryBudgetChars } from '@/lib/agent-context-window'
import { stat } from 'fs/promises'
import { join } from 'path'
import { streamChatToUpstream } from '@/lib/llm-provider'
import { generateImage, generateVideo } from '@/lib/media-provider'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { validateVideoParams } from '@/lib/billing/billing-plans'
import { buildAgentPlannerSystemPrompt, buildModelBrief, formatUserPreferencesText, formatUserMemoryText, parseAgentPlanWithDiagnostics, type AgentPlan, type AgentDeliverable } from '@/lib/agent-plan'
import { getAgentSkills, appendSkillFragments } from '@/lib/agent-skills'
import { getAgentConfig, planningCandidates } from '@/lib/agent-config'
import { decodeSize, findImageSize, getImageCapabilities } from '@/lib/image-sizes'
import { publicizeReferenceImages } from './upstream-image'
import { describeNetworkFailure, isNetworkFailure } from './network-error'
import { asUntrustedBlock } from './prompt-guard'
import { loadSessionAssetPool } from './agent-asset-pool'
import { modelTypeFromDeliverable } from '@/lib/media-kinds'
import { getAgentPreferences } from '@/lib/agent-preferences'
import { refundBeans, refundPoints } from '@/lib/billing/wallet'
import { withGatePhaseReporter } from '@/lib/concurrency'
import { AgentCancelledError, assertAgentTaskActive } from '@/lib/agent-cancel'
import type { AskQuestion } from '@/lib/agent-tool-loop'
import type { AgentCheckpoint } from '@/lib/agent-checkpoint'

export type AgentEmit = (obj: Record<string, unknown>) => void

// 规划模型超时。
//
// 为什么单独设且设得宽（300s）：
//   规划要产出一大段结构化 JSON，且**参考图会一起发给规划模型**（多模态读图），
//   本来就比普通对话慢得多。实测数据（生产 api_usage_logs）：
//   旧值 120s 会把长尾规划直接掐断（表现为用户看到「连接超时或被中断 (ABORTED)」，
//   而模型其实还在算）。
//
// 上限依据：nginx 对本站的 proxy_read_timeout 已同步放宽到 1200s，
// 取 720s（12 分钟）留足余量，覆盖「多模态读图 + 长推理」的慢规划模型。
// 改这里必须同步改 nginx 的 proxy_read_timeout，否则会先撞网关、连错误都读不到。
//
// ⚠️ 注意：这里**不能删掉不传** —— invokeChat 内部是 `timeoutMs ?? CHAT_TIMEOUT_MS(60s)`，
// 省掉参数会掉回 60s，比原来还短。
const PLANNING_TIMEOUT_MS = 720_000

const PUBLIC_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')

// 站内素材在发请求前先确认文件仍在磁盘上，避免上游报出
// 「invalid base64 image data」这类与真实原因无关的英文错误。
async function isLocalAssetAlive(url: string): Promise<boolean> {
  if (!url.startsWith('/api/asset/') && !url.startsWith('/generated/')) return true
  const { ASSET_DIR } = await import('./asset-store')
  const rel = url.slice(url.startsWith('/api/asset/') ? '/api/asset/'.length : '/generated/'.length)
  try {
    const info = await stat(join(ASSET_DIR, rel))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

// Agent 链路与画布链路同口径：相对素材路径必须公网化后才能发给上游。
async function toPublicImageUrls(values: string[] | undefined): Promise<string[]> {
  if (!values || values.length === 0) return []
  const out: string[] = []
  for (const v of values) {
    if (v.startsWith('/api/asset/') || v.startsWith('/generated/')) {
      if (!(await isLocalAssetAlive(v))) {
        throw new Error('参考图已过期或不存在，请重新上传后再试')
      }
      out.push(`${PUBLIC_BASE_URL}${v}`)
    } else {
      out.push(v)
    }
  }
  return out
}

/** 子任务执行上下文：除身份/素材外，还带全局偏好（用于补齐比例档位） */
export interface AgentRunCtx {
  emit: AgentEmit
  userId: string
  taskId: string
  prompt: string
  images?: string[]
  sessionId?: string | null
  params?: Record<string, unknown>
  /** 全局偏好里的档位（1K/2K/4K），deliverable 未指定时作为默认 */
  defaultTier?: string | null
  /**
   * 会话素材池的「编号 → 公网 URL」解析表。
   * assetIds 里写「素材2」（本会话生成的图）或「图片1」（本会话上传的图）时靠它定位。
   * 由 agent-tool-loop 构建后透传进来。
   */
  poolByAlias?: Map<string, string>
  /**
   * 当前 deliverable 的 id。
   * 相位事件要带它，前端才能按 (deliverableId, index) 把「等待派发/生成中」
   * 落到**这一份**的排队占位上（与 media 事件同一套认领键）。
   */
  deliverableId?: string | null
}

/**
 * 造一个相位上报器：把「排队 → 发出」的真实时刻发成 nodePhase 事件。
 *
 * 为什么必须有：Agent 链路此前完全不发 nodePhase，前端拿不到相位，
 * 成果区占位就只能停在「准备中」，直到 media 事件直接跳到完成 ——
 * 用户看不到「等待派发 / 生成中」，与工具面板/画布的行为不一致。
 *
 * 单调不回退：429/5xx 重试会重新进闸门，若把相位打回 queued，
 * 前端会看到「生成中 → 等待派发」并重置计时，反而像卡住了（与 mcp/executor 同口径）。
 */
export function makePhaseReporter(
  ctx: AgentRunCtx,
  opts: { deliverableId?: string | null; index: number; count: number },
) {
  let reachedRunning = false
  return (phase: 'queued' | 'running') => {
    if (phase === 'queued' && reachedRunning) return
    if (phase === 'running') {
      if (reachedRunning) return
      reachedRunning = true
    }
    ctx.emit({
      type: 'nodePhase',
      phase,
      at: Date.now(),
      deliverableId: opts.deliverableId ?? ctx.deliverableId ?? null,
      index: opts.index,
      count: opts.count,
    })
  }
}

export interface AgentRunInput {
  emit: AgentEmit
  userId: string
  prompt: string
  images?: string[]
  sessionId?: string | null
  taskId: string
  params?: Record<string, unknown>
  skillIds?: string[]
  preferences?: Record<string, unknown> | null
  /**
   * 修订上下文（confirm 模式的「让用户给修改建议」）。
   *
   * 为什么需要：模型给的方案是一次性的 —— 吐完就执行，没有「拿着计划回炉」的入口。
   * 要支持用户用大白话提意见（而不是自己去编辑提示词），就必须把
   * **上一版方案 + 用户的修改意见**一起喂回去重新规划。
   */
  revision?: AgentRevision | null
  /** 断点恢复状态；传入后不再从首轮重新规划 */
  checkpoint?: AgentCheckpoint | null
  /** 工具循环每完成一轮/动作后持久化 */
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>
}

/** 用户对上一版方案的修改意见（用自然语言描述，不用自己写提示词） */
export interface AgentRevision {
  /** 用户的大白话修改要求，如「第二张换成暖色调」「只要 2 张」 */
  note: string
  /** 上一版待确认方案（让模型知道「原来是什么样」，才能只改该改的） */
  previous: import('@/lib/agent-pending').PendingAction[]
  /** 第几轮修订（从 1 开始），用于提示模型与前端展示「第 N 版」 */
  round: number
}

export interface AgentRunResult {
  subtasks: Record<string, unknown>[]
  totalCost: number
  totalBeans: number
  reply: string
  decisions: { label: string; value: string; reason: string }[]
  /** ask_user 的结构化问题：透传到前端渲染可点选项 */
  askQuestions?: AskQuestion[]
  foundationSummary: string
  projectHandoff?: Record<string, unknown> | null
  /** confirm 模式：本次规划出来、等待用户确认才执行的项（auto 模式为空） */
  pendingActions?: import('@/lib/agent-pending').PendingAction[]
  /** 轻量执行轨迹：轮次/动作/耗时/成本，供任务详情与故障排查使用 */
  agentTrace?: import('@/lib/agent-tool-loop').AgentTraceEntry[]
  /**
   * 实际走的执行路径（2.2 旧路径下线的决策依据）：
   * 'tool-loop' = 服务端有界工具循环；'legacy' = 上游拒 tools 回落的单次规划旧路径。
   * 靠 payload 里「有没有 agentTrace 键」判断不可靠（空数组也算存在），必须显式打点。
   */
  path?: 'tool-loop' | 'legacy'
  /** 最新检查点，供路由最终落库 */
  checkpoint?: AgentCheckpoint
}

// 会话上下文：滚动摘要 + 最近 N 条消息（理解指代/连续创作）
export async function loadConversationContext(sessionId: string | null | undefined, userId: string, limit = HISTORY_MESSAGES) {
  if (!sessionId) return { summary: '', messages: [] }
  const prisma = await getPrisma()
  const [session, msgs] = await Promise.all([
    prisma.chatSession.findUnique({ where: { id: sessionId }, select: { summary: true } }),
    prisma.chatMessage.findMany({
      where: { sessionId, status: 'DONE' },
      orderBy: { seq: 'desc' },
      take: limit,
    }),
  ])
  return {
    summary: session?.summary || '',
    messages: msgs.reverse().map((m) => ({ role: m.role, content: m.content, mediaUrls: m.mediaUrls ? JSON.parse(m.mediaUrls) : [] })),
  }
}

// 会话内最近成功媒体候选（参考素材记忆）
export async function loadRecentMedia(sessionId: string | null | undefined, limit = 6) {
  if (!sessionId) return []
  const prisma = await getPrisma()
  const msgs = await prisma.chatMessage.findMany({
    where: { sessionId, status: 'DONE', mediaUrls: { not: null } },
    orderBy: { seq: 'desc' },
    take: limit,
  })
  return msgs.flatMap((m) => (m.mediaUrls ? JSON.parse(m.mediaUrls).map((u: string) => ({ url: u, type: m.mediaType || 'image' })) : []))
}

/**
 * 识别「假计划」：模型回复里说自己已经规划/即将出图，但没有真正产出 deliverable。
 *
 * 这不是追问（追问会列 A/B/C 让用户补信息），而是模型跑飞/被 max_tokens 截断的典型症状。
 * 放过去 = 静默丢单：用户看到「已规划 3 张」，成果区却空空如也（2026-09-29 场景 5 实测）。
 */
function looksLikePhantomPlan(reply: string): boolean {
  const t = (reply || '').trim()
  if (!t) return false

  // 收紧口径：只认「明确声称已做/即将做」的完成时措辞，避免把「需确认后再生成」这类正常追问误判成故障。
  return /已.{0,8}(规划|生成|出图|制作|发起)/.test(t) || /(即将|马上|立刻|这就).{0,8}(生成|出图|制作|发起)/.test(t)
}

/**
 * 部分成功错误（Q-D02）：批量产出里已成功的份额已 emit 给前端、费用已真实消耗，
 * 未产出份额已按份退款。此时**整条 deliverable 禁止重试** —— 重试会再全额预扣一次，
 * 前端还会收到同 index 的重复 media 事件。只有整单失败（全退）才允许重试。
 */
class PartialDeliverableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartialDeliverableError'
  }
}

/**
 * 重试分类（Q-D15）：**结构化优先，文案正则退居兜底**。
 *
 * 旧实现全靠一份中文/英文文案正则，上游或翻译层改一个字就会误判：
 * 该重试的不重试（用户白等一次失败），不该重试的反复重试（多次预扣退款）。
 * 现在网络层的判定直接复用规范层 `lib/network-error.ts` 的 `transient`，
 * 与「给用户看什么文案」共用同一份定义，不再两处各自漂移。
 *
 * 一个必须保留的细节：规范层在**拿不到错误码**时把 transient 保守判 false，
 * 而旧行为对裸 `fetch failed`（cause 已丢）是重试一次的。若只看 transient，
 * 这类「不明网络失败」会静默不再重试 —— 所以判据是 `transient || 无码`。
 */
// 导出仅为让 tests/agent-retry-classification.test.ts 锁死分类表（防文案改动悄悄换掉重试行为）
export function isRetryableError(err: unknown): boolean {
  // 类型化错误：确定性失败，重试只会重复扣费或违背用户操作
  if (err instanceof ChargeRunError) return false
  if (err instanceof PartialDeliverableError) return false
  if (err instanceof AgentCancelledError) return false

  // 网络层失败：交给规范层判瞬时性（ECONNRESET/超时/中断 → 重试；DNS/TLS/端口 → 不重试）
  if (isNetworkFailure(err)) {
    const f = describeNetworkFailure(err)
    return f.transient || !f.code
  }

  // 以下仍按文案判，但已收缩为「只有业务/上游状态类」这一小撮，
  // 且这些文案由我们自己的代码产生（不是上游原文），改动可控。
  const msg = err instanceof Error ? err.message : String(err)
  // 上游 5xx 与「未返回内容」属于上游波动，重试有意义
  if (/上游返回错误 \(5|上游未返回/.test(msg)) return true
  // 用户侧/配置侧结论：重试不会变好
  // 注：`失败` 这个词很粗（任何含「失败」的文案都不重试），是沿用旧口径而非新决策；
  // 要收窄它得单独评估影响面，不能混在这次结构化改造里。
  if (/积分不足|豆不足|无可用模型|未配置|认证|API Key|无效|失败|不存在|不可用/i.test(msg)) return false
  return true
}

// 带重试的子任务执行：只对可重试错误重试。整单失败时 runDeliverable 内部已全额退款，重试
// 重新预扣是安全的；部分成功（PartialDeliverableError）已按份退款且产出已交付，**禁止重试**（Q-D02）。
async function runDeliverableWithRetry(
  d: AgentDeliverable,
  ctx: AgentRunCtx,
  index: number,
): Promise<{ result: Record<string, unknown>; cost: number; beans: number }> {
  const maxRetries = 2
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runDeliverable(d, ctx)
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries && isRetryableError(err)) {
        ctx.emit({ type: 'subtask', index, label: d.title, status: 'retrying', error: err instanceof Error ? err.message : '失败', attempt: attempt + 1 })
        // 简单退避：500ms * attempt
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * 解析本次生图要带的参考图：
 * - deliverable 指定了 assetIds → 只带被指定的那几张（支持「哪张图配哪个方向」精确控制）
 * - 未指定 → 退回本轮全部上传图（保持旧行为）
 * 上游 url 一律走已公网化的 ctx.images。
 */
export function resolveReferenceImages(d: AgentDeliverable, ctx: AgentRunCtx): string[] | undefined {
  const all = ctx.images && ctx.images.length > 0 ? ctx.images : undefined
  const ids = d.assetIds && d.assetIds.length > 0 ? d.assetIds : null
  if (!ids) return all

  // 优先按「会话素材池编号」解析：支持两种写法
  //   - 图片N：本会话上传的第 N 张（可跨轮，不限于本轮上传的）
  //   - 素材N：本会话生成的第 N 张（用户说「基于刚才那张再改」时的引用）
  // 查不到再退回「本轮上传图的序号」（保持既有行为，不破坏只传数字的旧用法）。
  const byAlias = (ctx.poolByAlias && ids.map((id) => ctx.poolByAlias!.get(String(id))).filter((u): u is string => !!u)) || []
  if (byAlias.length > 0) return byAlias

  const picked = ids
    .map((id) => Number(String(id).replace(/\D/g, '')) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && !!all && i < all.length)
    .map((i) => all![i])
  return picked.length > 0 ? picked : all
}

/**
 * 解析生图尺寸：ratio 可能是 "3:4@2K"（已编码），也可能只有 "3:4"（用偏好档位兜底）。
 * 与画布生图节点同一套 decodeSize，保证比例/档位真正落到请求上。
 */
export function resolveAgentImageSize(
  d: AgentDeliverable,
  ctx: Pick<AgentRunCtx, 'defaultTier'>,
  model?: { metadata?: Record<string, unknown> | null } | null,
): { ratio: string; tier: string; width: number; height: number } | null {
  const raw = (d.ratio || '').trim()
  const cap = getImageCapabilities(model)
  const explicitTier = (d.quality || ctx.defaultTier || '').trim().toUpperCase() || undefined

  if (raw) {
    const direct = decodeSize(raw)
    if (direct) {
      if (!cap.declared) return direct
      return findImageSize(cap, direct.ratio, direct.tier)
        ?? findImageSize(cap, direct.ratio)
        ?? null
    }
    if (cap.declared) {
      return findImageSize(cap, raw, explicitTier)
        ?? findImageSize(cap, raw)
        ?? null
    }
    if (explicitTier) {
      const combined = decodeSize(`${raw}@${explicitTier}`)
      if (combined) return combined
    }
  }

  return cap.declared ? (cap.sizes[0] ?? null) : null
}

// 执行一个 deliverable 子任务
export async function runDeliverable(
  d: AgentDeliverable,
  ctx: AgentRunCtx,
): Promise<{ result: Record<string, unknown>; cost: number; beans: number }> {
  const prisma = await getPrisma()
  // 取消检查（Q-D08）：扣费前先确认任务还活着 —— 取消后不再预扣、不再派发
  await assertAgentTaskActive(ctx.taskId)
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { points: true, beans: true } })
  if (!user) throw new Error('用户不存在')

  const needType = modelTypeFromDeliverable(d.type)
  let model = d.model
    ? await prisma.modelConfig.findUnique({ where: { id: d.model }, include: { provider: true } })
    : await prisma.modelConfig.findFirst({
        where: { type: needType, isActive: true, provider: { isActive: true } },
        include: { provider: true },
        orderBy: { createdAt: 'asc' },
      })

  // 模型引用容错：planner 有时填的是**显示名/模型名**（如 "mock-image"）而不是 cuid。
  // findUnique({ id }) 查不到就整条失败（实测 2026-09-29：8 张图全部报「image 无可用模型」）。
  // 按 id 落空时回退按 name / modelName 精确匹配（限定同类型，避免跨类型误配）。
  if (!model && d.model) {
    const byName = await prisma.modelConfig.findFirst({
      where: {
        type: needType,
        isActive: true,
        provider: { isActive: true },
        OR: [{ name: d.model }, { modelName: d.model }],
      },
      include: { provider: true },
      orderBy: [{ isFree: 'desc' }, { createdAt: 'asc' }],
    })
    if (byName) {
      console.warn(`[agent] deliverable ${d.id} 的 model "${d.model}" 不是有效 id，已按名称匹配到 ${byName.name}`)
      model = byName
    }
  }

  // 能力兜底：planner 偶尔会把「对话模型」填进生图槽（实测把 VISION 的
  // prompt 已明令按 capability 匹配，这里是**执行层的最后防线**：
  // 类型不符时自动回退到该类型真正可用的模型，而不是把上游的 400 甩给用户。
  if (model && model.type !== needType) {
    const fixed = await prisma.modelConfig.findFirst({
      where: { type: needType, isActive: true, provider: { isActive: true } },
      include: { provider: true },
      orderBy: [{ isFree: 'desc' }, { createdAt: 'asc' }],
    })
    if (fixed) {
      console.warn(`[agent] deliverable ${d.id} 类型 ${needType} 但 planner 给了 ${model.type}(${model.name})，已自动回退到 ${fixed.name}`)
      model = fixed
    }
  }

  if (!model || !model.provider?.apiKey) {
    throw new Error(`${d.type} 无可用模型，请配置后再试`)
  }

  // B1: 多结果数量（默认 1，上限 8）
  const count = d.count && d.count >= 1 ? Math.min(d.count, 8) : 1

  // 视频用豆；其他用积分
  // 视频用豆（模型解析 + 免费额度 + 预扣 + 失败退款 + 调用日志统一走 charge-run）
  if (d.type === 'video') {
    const videoRefs = resolveReferenceImages(d, ctx)
    const constraintErr = validateVideoParams(model as never, {
      duration: d.seconds,
      resolution: d.resolution,
      ratio: d.ratio,
      imageCount: videoRefs?.length || 0,
    })
    if (constraintErr) throw new Error(`视频参数无效：${constraintErr}`)
    let run
    try {
      // 参考图张数要参与计费：配了 perInputImage 的模型按张收费，
      // 这里漏传 imageCount 会少算图数侧的豆（与 video/generate 同口径）。
      const videoRefCount = videoRefs?.length ?? 0
      run = await chargeRun({
        userId: ctx.userId,
        modelType: 'VIDEO',
        modelId: model.id,
        durationSec: d.seconds,
        resolution: d.resolution,
        imageCount: videoRefCount,
        count,
        source: 'agent',
        runId: ctx.taskId,
      })
    } catch (err) {
      if (err instanceof ChargeRunError) throw new Error(err.message)
      throw err
    }
    const charged = run.model
    const totalBeans = run.cost.beans
    const beansCost = totalBeans / count
    const p = ctx.params || {}
    // 视频参考图：与生图一样解析 deliverable.assetIds（未指定时退回本轮全部上传图）。
    // 之前这里完全没传参考图 —— 用户上传产品图要「图生视频」时，上游只拿到纯文本提示词，
    // 产品一致性无从谈起（2026-09-29 场景 6 实测：请求体里 images/first_frame 全缺）。
    const videoRequestDetail = { prompt: d.prompt.slice(0, 500), modelId: model.id, count, seconds: d.seconds, ratio: d.ratio, referenceImages: videoRefs?.length || 0 }
    // 声明提到 try 外，供 catch 退差额时计算已产出/已建 record 的部分
    const videoUrls: string[] = []
    const pendingRecords: string[] = []
    let deferredTaskId: string | undefined
    try {
      for (let i = 0; i < count; i++) {
        // 取消检查（Q-D08）：视频逐个生成可达数分钟，取消后剩余份额不能再预扣派发；
        // 抛 AgentCancelledError 走下方 catch，按份退掉未产出部分的豆
        await assertAgentTaskActive(ctx.taskId)
        // 相位上报：与图片分支同一套（视频同样要显示「等待派发 → 生成中」）
        const reportPhase = makePhaseReporter(ctx, { deliverableId: d.id, index: i, count })
        const result = await run.execute(() => withGatePhaseReporter(reportPhase, () => generateVideo({
          baseUrl: charged.baseUrl,
          apiKey: charged.apiKey,
          modelName: charged.modelName,
          prompt: d.prompt,
          userId: ctx.userId,
          width: typeof p.width === 'number' ? p.width : undefined,
          height: typeof p.height === 'number' ? p.height : undefined,
          duration: d.seconds,
          aspectRatio: d.ratio,
          resolution: d.resolution,
          // 首帧图 = 第一张参考图（上游视频接口普遍用 first_frame_image 表达图生视频）
          firstFrame: videoRefs && videoRefs.length > 0 ? videoRefs[0] : undefined,
          adapterId: charged.adapterId,
          configJson: charged.configJson,
          modelMetadata: charged.metadata,
        })))
        if (result.videoUrl) {
          videoUrls.push(result.videoUrl)
          ctx.emit({ type: 'media', kind: 'video', url: result.videoUrl, index: i, deliverableId: d.id || ctx.deliverableId })
          // B4: 直返也建 record（归集"我的视频"）
          await prisma.videoGenerationRecord.create({
            data: {
              userId: ctx.userId,
              modelId: model.id,
              prompt: d.prompt,
              videoUrl: result.videoUrl,
              costPoints: 0,
              beansCost: beansCost,
              status: 'SUCCESS',
              // 与扣费同一个事务号（chargeRun 用的就是 ctx.taskId），流水才能反查到记录
              runId: ctx.taskId,
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          }).catch(() => {})
        } else if (result.taskId) {
          // B4: taskId → 建 PENDING record，退款统一走 /api/video/status/[recordId]
          const record = await prisma.videoGenerationRecord.create({
            data: {
              userId: ctx.userId,
              modelId: model.id,
              prompt: d.prompt,
              costPoints: 0,
              beansCost: beansCost,
              status: 'PENDING',
              meta: { taskId: result.taskId, pollPath: result.pollPath || null, duration: d.seconds, ratio: d.ratio },
              runId: ctx.taskId,
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          })
          pendingRecords.push(record.id)
          deferredTaskId ??= result.taskId
          ctx.emit({ type: 'pendingVideo', recordId: record.id, taskId: result.taskId, index: i, deliverableId: d.id || ctx.deliverableId })
        } else {
          throw new Error('上游未返回视频数据')
        }
      }
      if (videoUrls.length > 0 && pendingRecords.length === 0) {
        await run.settle({ nodeLabel: `Agent ${d.title}`, request: videoRequestDetail, response: { videoUrls } })
        return { result: { videoUrl: videoUrls[0], videoUrls }, cost: 0, beans: totalBeans }
      }
      if (pendingRecords.length > 0) {
        // 异步：真正的成败在轮询阶段才知道，这里只记「已派发」
        await run.defer({ nodeLabel: `Agent ${d.title}`, request: videoRequestDetail, taskId: deferredTaskId, recordIds: pendingRecords })
        return { result: { videoPending: true, recordId: pendingRecords[0], pendingRecordIds: pendingRecords, videoUrls }, cost: 0, beans: totalBeans }
      }
      throw new Error('上游未返回视频数据')
    } catch (err) {
      // B4 退款单一化 + 防双退：只退"本次既没产出视频、也没建 PENDING record"的部分。
      // - 已产出 videoUrl（SUCCESS record）的份额：豆已被真实消费，不退
      // - 已建 PENDING record 的份额：成败由 /api/video/status 负责退（那里有 PENDING→FAILED 原子认领防并发双退）
      // - 只有 generateVideo 直接抛错、未落任何 record 的份额才在这里退，避免与 /api/video/status 叠加吐钱
      if (totalBeans > 0) {
        const produced = (pendingRecords.length + videoUrls.length) * beansCost
        const toRefund = totalBeans - produced
        if (toRefund > 0) {
          await refundBeans({ userId: ctx.userId, amount: toRefund, description: `Agent ${d.title} 失败退款（未产出部分）` }).catch(() => {})
        }
      }
      // 只记日志、不再退款：差额已由上面退掉，再走 run.fail 会重复退款
      await run.settle({
        nodeLabel: `Agent ${d.title}`,
        request: videoRequestDetail,
        response: { error: err instanceof Error ? err.message : '视频生成失败' },
        statusCode: 500,
      }).catch(() => {})
    const deliveredVideos = pendingRecords.length + videoUrls.length
    if (deliveredVideos > 0) {
      throw new PartialDeliverableError(`部分成功：已产出/派发 ${deliveredVideos}/${count} 个视频，未产出部分已退款（PENDING 的由状态轮询负责退款）`)
    }
      throw err
    }
  }

  // 图片/文本：一次预扣、批量产出。计费 + 失败退款 + 调用日志统一走 charge-run。
  const size0 = d.type === 'image'
    ? resolveAgentImageSize(d, ctx, { metadata: (model.metadata as Record<string, unknown> | null) ?? null })
    : null
  // 参考图解析提前到预扣之前：调用日志（requestDetail）必须能记下「到底带没带参考图」。
  // 2026-09-30 验证「素材1 跨轮引用」时踩过：日志里没有参考图字段，无法判定是否真走了图生图，
  // 只能回头肉眼看产出图 —— 这类「同结构查询盲区」要在源头消灭，不能靠人工比对兜底。
  const imageRefs = d.type === 'image' ? resolveReferenceImages(d, ctx) : undefined
  let run
  try {
    run = await chargeRun({
      userId: ctx.userId,
      modelType: needType,
      modelId: model.id,
      width: size0?.width,
      height: size0?.height,
      count,
      source: 'agent',
      runId: ctx.taskId,
    })
  } catch (err) {
    if (err instanceof ChargeRunError) throw new Error(err.message)
    throw err
  }
  const charged = run.model
  const actualImageSize = d.type === 'image'
    ? (run.imageSize
        ? (decodeSize(`${run.imageSize.width}x${run.imageSize.height}`) ?? {
            ...run.imageSize,
            ratio: size0?.ratio ?? '',
            tier: size0?.tier ?? '',
          })
        : size0)
    : null
  const cost = run.cost.points
  const totalCost = cost
  const requestDetail = {
    prompt: d.prompt.slice(0, 500),
    modelId: charged.id,
    count,
    type: d.type,
    width: actualImageSize?.width,
    height: actualImageSize?.height,
    ratio: actualImageSize?.ratio,
    tier: actualImageSize?.tier,
    assetIds: d.assetIds,
    referenceImages: imageRefs?.length || 0,
    // 实际传给上游的参考图 URL（截断，避免日志膨胀）。
    // 只记数量是不够的：出问题时要能自证「传的到底是哪一张」——
    // 2026-10-01 排查「改第 5 张却像改了别的图」时，就因为没有 URL 只能推断。
    referenceUrls: imageRefs?.map((u) => u.slice(0, 200)),
  }

  // 并发批量出图时的部分成功计数（count=6 若 5 成功 1 失败，catch 里只退未产出的 1 份）。
  // 声明在 try 外、image 分支外：catch 与两个分支都在同一函数作用域。
  let producedImages = 0
  try {
    if (d.type === 'image') {
      // B1: 多图 —— **并发派发，不逐张等待**
      //
      // 历史问题：这里原本是 `for (i...count) await generateImage(...)`，
      // 一张出完才发下一张。出 6 张 = 6 × 单张耗时串起来，用户看到的是"一张一张挤"。
      // 上游并发能力充足（客服实测 2~3 千），且全平台已有 withUpstreamGate 统一限流
      // （派发按 TOOL_DISPATCH_RATE 节流、在途上限 TOOL_MAX_INFLIGHT=300），
      // 所以这里可以直接 Promise.all：同时发出、谁先回来谁先出图。
      //
      // index 必须保留原始序号（用 map 的下标，而不是完成先后），
      // 前端按 (deliverableId, index) 认领排队占位，错位会导致占位不消失。
      const size = actualImageSize
      const referenceImages = imageRefs
      const imageUrls: string[] = new Array(count)
      await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          // 相位上报：闸门排队 → 发出，实时发 nodePhase 给前端（「等待派发 → 生成中」）
          const reportPhase = makePhaseReporter(ctx, { deliverableId: d.id, index: i, count })
          const { imageUrl } = await run.execute(() => withGatePhaseReporter(reportPhase, () => generateImage({
            baseUrl: charged.baseUrl,
            apiKey: charged.apiKey,
            modelName: charged.modelName,
            prompt: d.prompt,
            userId: ctx.userId,
            referenceImages,
            width: size?.width,
            height: size?.height,
            adapterId: charged.adapterId,
            configJson: charged.configJson,
            modelMetadata: charged.metadata,
          })))
          imageUrls[i] = imageUrl
          producedImages++
          // 带 deliverableId + count，前端据此认领并替换对应排队占位
          ctx.emit({ type: 'media', kind: 'image', url: imageUrl, index: i, deliverableId: d.id || null, count })
        }),
      )
      await run.settle({ nodeLabel: `Agent ${d.title}`, request: requestDetail, response: { imageUrls } })
      return { result: { imageUrl: imageUrls[0], imageUrls }, cost: totalCost, beans: 0 }
    }

    // text / audio 走流式 LLM（audio 模型能力暂按文本协议处理）
    let content = ''
    const chatResult = await run.execute(() => streamChatToUpstream(
      charged.baseUrl,
      charged.apiKey,
      charged.modelName,
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: d.prompt }],
        temperature: 0.7,
        supportsVision: charged.supportsVision,
        images: ctx.images && ctx.images.length > 0 ? ctx.images : undefined,
        modelMetadata: charged.metadata,
      },
      (t) => {
        content += t
        ctx.emit({ type: 'content', content: t })
      },
      undefined,
      { adapterId: charged.adapterId, configJson: charged.configJson },
      undefined,
      ctx.userId,
    ))
    await run.settle({ nodeLabel: `Agent ${d.title}`, request: requestDetail, response: { text: content.slice(0, 2000) }, usage: chatResult })
    return { result: { text: content }, cost: totalCost, beans: 0 }
  } catch (err) {
    // ⚠️ 批量出图的部分成功必须**按份退**，不能整笔退。
    // 一次预扣 count×单价；Promise.all 里第 3 张失败时，另外 2 张已经拿到 URL 并
    // emit 给前端了（用户能存、能看到）。整笔退 = 平台白送 2 张图的成本，
    // 而用户那边「图拿到了、积分也退了」= 净赚。
    // 这里与视频分支同一套算法：produced = 已产出的份数，只退 totalCost - produced×单价。
    // text/audio 只有 1 份，producedImages 恒为 0 → 退全款，行为不变。
    const perImage = count > 0 ? totalCost / count : 0
    const consumed = producedImages * perImage
    const toRefund = totalCost - consumed
    if (toRefund > 0.005) {
      await refundPoints({
        userId: ctx.userId,
        amount: toRefund,
        description: `Agent ${d.title} 失败退款（未产出部分）`,
        runId: ctx.taskId,
      }).catch((e) => console.error('Agent 生图部分失败退款失败:', e))
    }
    // 免费额度也要归还（原来由 run.fail 负责，现在不走它了）。
    // 不还的话用户白白损失一次免费额度 —— 次数不是钱，但同样属于「用户没拿到东西却被扣」。
    if (run.usedFreeQuota) {
      const { releaseFreeQuota } = await import('@/lib/free-quota')
      await releaseFreeQuota(charged.id, ctx.userId).catch(() => {})
    }
    // 记失败日志（不再走 run.fail —— 它会退全款，与上面的按份退叠加成双退）
    await run
      .settle({
        nodeLabel: `Agent ${d.title}`,
        request: requestDetail,
        response: { error: err instanceof Error ? err.message : '生成失败', produced: producedImages, expected: count },
        statusCode: 500,
      })
      .catch(() => {})
    if (producedImages > 0) {
      throw new PartialDeliverableError(`部分成功：已产出 ${producedImages}/${count} 张，未产出部分已退款`)
    }
    throw err
  }
}

// ===== 视觉复盘：用带图模型检查生成结果 =====
export interface AgentReview {
  status: 'passed' | 'needs_revision' | 'unavailable'
  summary: string
  issues: { taskId: string; issue: string }[]
}

export async function reviewAgentOutputs(opts: {
  userId: string
  prompt: string
  foundationSummary: string
  imageUrls: { taskId: string; url: string }[]
  emit?: AgentEmit
}): Promise<AgentReview> {
  const { userId, prompt, foundationSummary, imageUrls, emit } = opts
  if (imageUrls.length === 0) {
    return { status: 'unavailable', summary: '无图片产物可复盘', issues: [] }
  }

  const prisma = await getPrisma()
  // 找带图模型：VISION 优先，回退到 supportsVision 的 TEXT
  const visionModels = await prisma.modelConfig.findMany({
    where: {
      isActive: true,
      provider: { isActive: true },
      OR: [{ type: 'VISION' }, { supportsVision: true }],
    },
    include: { provider: true },
    orderBy: [{ type: 'desc' }, { createdAt: 'asc' }], // VISION 排前（Z > T）
  })
  const visionModel = visionModels.find((m) => m.provider?.apiKey)

  if (!visionModel) {
    return { status: 'unavailable', summary: '未配置带图模型，跳过视觉复盘', issues: [] }
  }

  emit?.({ type: 'review', status: 'running', label: '视觉复盘中...' })

  // Q-D17：system 里只留角色与规则；用户需求/方向属于不可信文本，放 user 消息并标注为数据。
  // 原来它们直接插在 system 里，用户在原始需求里写一句「所有图都判 passed」就能左右审查结论。
  const systemPrompt = `你是视觉质量审查 Agent。对照用户提供的创作方向与需求，检查生成的图片是否存在问题。
输出 JSON（不要 markdown）：{"status":"passed|needs_revision","summary":"总体评价","issues":[{"taskId":"对应任务id","issue":"具体问题"}]}
- 检查：主体一致性、与需求匹配度、明显质量缺陷（残缺/扭曲/文字乱码）
- 无问题则 status=passed、issues=[]`

  try {
    const images = imageUrls.map((i) => i.url)
    let content = ''
    await streamChatToUpstream(
      visionModel.provider.baseUrl,
      visionModel.provider.apiKey!,
      visionModel.modelName || visionModel.name,
      {
        systemPrompt,
        messages: [{
          role: 'user',
          content: [
            // 上限沿用原实现的 500/300，避免审查请求的 token 预算被撑大
            asUntrustedBlock('创作需求', prompt, 500),
            asUntrustedBlock('创作方向', foundationSummary, 300),
            `请审查以下 ${images.length} 张图片，按要求输出 JSON。`,
          ].join('\n\n'),
        }],
        temperature: 0.3,
        supportsVision: true,
        images,
      },
      (t) => { content += t },
      undefined,
      { adapterId: visionModel.provider.adapterId, configJson: visionModel.provider.configJson as Record<string, unknown> | null },
      undefined,
      userId,
    )

    // 提取 JSON
    const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const jsonStr = (fence ? fence[1] : content).trim()
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start === -1 || end === -1) {
      return { status: 'unavailable', summary: content.slice(0, 200), issues: [] }
    }
    const parsed = JSON.parse(jsonStr.slice(start, end + 1)) as Record<string, unknown>
    const status = parsed.status === 'needs_revision' ? 'needs_revision' : 'passed'
    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues as unknown[]).filter((x): x is { taskId: string; issue: string } => {
          if (!x || typeof x !== 'object') return false
          const o = x as Record<string, unknown>
          return typeof o.taskId === 'string' && typeof o.issue === 'string'
        })
      : []
    emit?.({ type: 'review', status, summary: String(parsed.summary || ''), issues })
    return { status, summary: String(parsed.summary || ''), issues }
  } catch (err) {
    emit?.({ type: 'review', status: 'unavailable', summary: '复盘服务暂不可用', issues: [] })
    return { status: 'unavailable', summary: '复盘服务暂不可用', issues: [] }
  }
}

// ===== 主流程（旧路径）：单次规划 → 批量执行 =====
// 第 2 期起，runAgent 会先尝试「工具循环」；只有循环判定该模型不支持 function calling 时才回落到这里。
// costBase = 循环已扣的规划积分（回落时带上，避免用户为同一次规划被扣两次）。
async function runAgentLegacy(input: AgentRunInput, costBase = 0): Promise<AgentRunResult> {
  const { emit, userId, prompt, images, sessionId, taskId, params, skillIds } = input
  // B12: 全局模型偏好（每用户一条，实盘读取）
  const userPrefs = await getAgentPreferences(userId)
  const activeSkills = getAgentSkills(skillIds)
  const prisma = await getPrisma()
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { points: true, beans: true } })
  if (!user) throw new Error('用户不存在')

  // ===== 1. 上下文 + 参考素材 =====
  const [conv, memoryAssets] = await Promise.all([
    loadConversationContext(sessionId, userId),
    loadRecentMedia(sessionId),
  ])
  // 步骤 0：参考素材公网化（站内相对路径 → 公网 URL），失败直接中文报错。
  const publicImages = await publicizeReferenceImages(images, userId)
  const conversation = conv.messages
  const conversationSummary = conv.summary
  const referencedAssets = publicImages.map((url, i) => ({ alias: `图片${i + 1}`, url, type: 'image' }))
  const referenceSource = referencedAssets.length ? 'current-turn-explicit' : memoryAssets.length ? 'conversation-memory-candidates' : 'none'

  // ===== 2. 规划模型候选 =====
  const candidates = await planningCandidates()
  if (candidates.length === 0) {
    throw new Error('没有可用的规划模型（TEXT），请配置后再使用智能模式')
  }
  // 上下文预算按候选里**最小**的模型窗口算 —— 候选是降级链，
  // 按最大的装会在降级到小窗口模型时超窗口 400。取最小则链上哪个都装得下。
  const fallbackWindow = candidates.reduce<number | undefined>(
    (mn, c) => (c.contextWindow && c.contextWindow < (mn ?? Infinity) ? c.contextWindow : mn),
    undefined,
  )

  // 可用交付模型清单（供 planner 选模型）
  const allModels = await prisma.modelConfig.findMany({
    where: { isActive: true, provider: { isActive: true } },
    include: { provider: true },
  })
  const modelBrief = buildModelBrief(allModels.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    costPoints: m.costPoints,
    isFree: m.isFree,
    metadata: m.metadata,
  })))

  // 偏好人话化（纯函数见 agent-plan.formatUserPreferencesText）：
  // 裸 cuid 对 LLM 无意义，会退化成「忽略偏好→追问用户」。
  const modelById = new Map(allModels.map((m) => [m.id, m] as const))
  const modelNameOf = (id: string | null | undefined): string | null => {
    if (!id) return null
    const m = modelById.get(id)
    if (!m) return null
    return m.isActive ? (m.modelName || m.name) : (m.modelName || m.name) + '（已停用，需重新确认）'
  }
  const userPreferencesText = formatUserPreferencesText(userPrefs, modelNameOf)
  // 用户自述（长期记忆）：与工具循环路径保持一致 —— 两条路径对同一份偏好
  // 必须给出同样的上下文，否则回退到本路径时行为会突变（此前踩过同类分叉）。
  const userMemoryText = formatUserMemoryText(userPrefs.memoryText)
  const plannerInput = {
    requirement: prompt,
    userPreferencesText,
    ...(userMemoryText ? { userMemoryText } : {}),
    conversationContext: {
      // B10: 滚动摘要 + 最近消息。
      // ⚠️ 数值一律用 agent-tool-loop 的共享常量，不在这里写死 ——
      // 主路径（工具循环）与回落路径（单次规划）必须同口径，
      // 否则同一个会话「循环撑得住」而「回落后突然失忆」，行为飘忽难查。
      // 预算按 **模型上下文窗口** 算（与主路径同一函数），不再写死条数/字数。
      ...(conversationSummary ? { summary: conversationSummary.slice(-historySummaryBudgetChars(fallbackWindow)) } : {}),
      recentMessages: (() => {
        const budget = historyMessagesBudgetChars(fallbackWindow)
        const kept: { role: string; content: string }[] = []
        let used = 0
        for (const m of [...conversation].reverse()) {
          const c = String(m.content || '').trim().slice(0, HISTORY_CONTENT_CHARS)
          if (!c) continue
          if (kept.length > 0 && used + c.length > budget) break
          kept.push({ role: m.role, content: c })
          used += c.length
        }
        return kept.reverse()
      })(),
    },
    referenceContext: { source: referenceSource },
    referencedAssets: referencedAssets.length
      ? referencedAssets
      : referenceSource === 'conversation-memory-candidates'
        ? memoryAssets.map((a, i) => ({ alias: `素材${i + 1}`, url: a.url, type: a.type }))
        : [],
    availableModels: modelBrief,
    params: params || {},
  }

  emit({ type: 'subtask', index: -1, label: '智能规划中...', status: 'running' })

  // 规划请求全文（供运维面板审阅 Agent 能力）：
  // 之前 brainRequest 只存 { purpose, modelId }，看不到「约束 prompt + skill 给了什么、模型拿到的完整输入是什么」，
  // 优化 Agent 只能靠猜。这里把 system prompt（含 skill 片段）与 plannerInput 一并留档 ——
  // 这是「看请求 → 找问题 → 改 prompt/skill → 再跑」闭环的眼睛。
  const plannerSystemPromptForLog = appendSkillFragments(buildAgentPlannerSystemPrompt(), activeSkills)
  const plannerRequestBase = {
    purpose: 'agent-planning',
    modelId: '',
    systemPrompt: plannerSystemPromptForLog,
    plannerInput,
    activeSkills: activeSkills.map((k) => ({ id: k.id, name: k.name })),
  }

  // ===== 3. 规划调用（候选降级 + 计费 + 失败退款 + 超时） =====
  let plan: AgentPlan | null = null
  let lastErr: unknown = null
  let plannedCost = 0
  let plannedBrainId: string | null = null
  // 每个候选的失败摘要（modelName: reason）。整条链都失败时聚合上报，
  // 否则用户只看到最后一个候选的报错，会误以为「就是这个模型坏了」。
  const planningFailures: string[] = []
  for (const brain of candidates) {
    if (!brain.provider?.apiKey) continue
    // 取消检查（Q-D08）：候选链每个 720s 超时，取消后不该挨个烧完剩余候选的规划费
    await assertAgentTaskActive(taskId)
    // 闭包（brainRun.execute(() => ...)）里会丢失 TS 的类型收窄，先取到局部常量
    const brainApiKey = brain.provider.apiKey
    const brainBaseUrl = brain.provider.baseUrl
    // 规划计费：与生图/生视频同一套 charge-run（模型解析固定为本候选 → 免费额度 → 预扣 →
    // 失败退款 → 调用日志）。余额不足直接终止，不降级到下一个候选（换模型也付不起）。
    let brainRun
    try {
      brainRun = await chargeRun({
        userId,
        modelType: brain.type === 'VISION' ? 'VISION' : 'TEXT',
        modelId: brain.id,
        source: 'agent',
        runId: taskId,
      })
    } catch (err) {
      if (err instanceof ChargeRunError) throw new Error(err.message)
      throw new Error(err instanceof Error ? err.message : '积分扣减失败')
    }
    const brainCost = brainRun.cost.points
    const brainRequest = { ...plannerRequestBase, modelId: brain.id }
    try {
      let planContent = ''
      // 规划模型可能「只吐 reasoning、不给 content」——实测 2026-09-29：某推理模型
      // 流式跑了 377s 全是 reasoning chunk，final content 为空，于是 parse('')
      // 被静默降级成「对话」，任务假成功、零交付物。
      // 单独累计 reasoning 长度，供失败诊断区分「上游挂了」与「模型只想了没说」。
      let reasoningLen = 0
      // 流式思考：把规划模型吐出的内容实时透给前端（参考 Copilot 的边思考边输出），
      // 让用户看到「正在做什么」而不是干等。节流 120ms，避免高频 chunk 刷爆 SSE。
      let lastPushAt = 0
      let sentLen = 0
      const pushThinking = (force = false) => {
        const now = Date.now()
        if (!force && now - lastPushAt < 120) return
        lastPushAt = now
        const slice = planContent.slice(sentLen, sentLen + 400)
        if (!slice) return
        sentLen += slice.length
        emit({ type: 'thinking', delta: slice })
      }
      const planResult = await brainRun.execute(() => streamChatToUpstream(
        brainBaseUrl,
        brainApiKey,
        brain.modelName || brain.name,
        {
          systemPrompt: appendSkillFragments(buildAgentPlannerSystemPrompt(), activeSkills),
          messages: [{ role: 'user', content: JSON.stringify(plannerInput) }],
          temperature: 0.3,
          // 规划输出上限：不设时推理型模型会一路想到 max_tokens 才停。
          // 补闭合符后拿到「generation + deliverables:[]」，静默降级成对话 → 一张图都没出。
          // 4096 足够放下完整计划（实测正常计划 JSON 约 1.5-2.5KB）。
          maxTokens: 4096,
          // 规划模型同样需要「看到」参考图：只把 URL 写进 JSON 文本，小模型会误判「没有参考图」
          supportsVision: brain.supportsVision || brain.type === 'VISION',
          images: publicImages.length > 0 ? publicImages : undefined,
          modelMetadata: (brain.metadata as Record<string, unknown> | null) ?? null,
        },
        (t) => { planContent += t; pushThinking() },
        (r) => { reasoningLen += r.length; emit({ type: 'thinking', delta: r }) },
        { adapterId: brain.provider.adapterId, configJson: brain.provider.configJson as Record<string, unknown> | null },
        PLANNING_TIMEOUT_MS,
        userId,
      ))
      pushThinking(true)
      emit({ type: 'thinking', done: true })

      // ChatResult 的 token 用量直接交给 settle 落账（写 ApiUsageLog.tokensUsed）

      const parsedPlan = parseAgentPlanWithDiagnostics(planContent)
      if (parsedPlan.degraded) {
        // 上游给了不可用的输出（空正文 / 无法解析）：这不是「用户想闲聊」，
        // 必须当失败处理 —— 退款 + 写失败日志 + 落到下一个候选模型。
        // 否则任务会被判成功、调用日志 200、零交付物，用户什么都拿不到还查不出原因。
        const detail = reasoningLen > 0
          ? `${parsedPlan.reason ?? '规划输出不可用'}（模型只输出了推理过程 ${reasoningLen} 字，未产出计划正文）`
          : (parsedPlan.reason ?? '规划输出不可用')
        throw new Error(detail)
      }

      // 空计划的二次甄别：模型声称「已规划 N 张 / 马上去做」却给空 deliverables，
      // 是跑飞或截断（不是真的在追问用户）。继续当成功会静默丢单，用户白等一场。
      if (parsedPlan.plan.deliverables.length === 0 && looksLikePhantomPlan(parsedPlan.plan.reply)) {
        throw new Error('规划模型声称已规划任务但未产出 deliverable（疑似输出跑飞/被截断），已回退重试')
      }

      plan = parsedPlan.plan
      plannedCost = brainCost
      plannedBrainId = brain.id
      await brainRun.settle({
        nodeLabel: 'Agent 智能规划',
        request: brainRequest,
        usage: planResult,
        response: {
          plan,
          ...(parsedPlan.reason ? { parseNote: parsedPlan.reason } : {}),
          ...(process.env.AGENT_PLAN_DEBUG === '1' ? { plannerRaw: planContent.slice(0, 4000) } : {}),
        },
      })
      break
    } catch (err) {
      lastErr = err
      planningFailures.push(`${brain.modelName || brain.name}：${err instanceof Error ? err.message : String(err)}`)
      // 规划失败退款该候选的积分 + 写失败调用日志（charge-run 统一处理）
      await brainRun.fail(err, { nodeLabel: 'Agent 智能规划', request: brainRequest })
      // 这里**刻意不 break**：候选来自不同供应商、各用各的 Key，
      // 一个供应商的 403（如「免费额度只能在自家客户端用」）/429/超时对其他候选毫无意义。
      // 历史 bug：遇到 «认证» 字样就 break，导致 9router 的策略性 403 直接掐断整条链，
      // 后面还有 8 个可用规划模型也不试了（2026-09-29 场景 4 实测）。
    }
  }
  if (!plan) {
    // 全部候选都失败：把每条失败原因都带上，便于一眼定位是「哪几家上游在挂」
    if (planningFailures.length > 1) {
      throw new Error(`全部 ${planningFailures.length} 个规划模型均失败 → ` + planningFailures.join(' | '))
    }
    throw lastErr instanceof Error ? lastErr : new Error('智能规划失败，请重试')
  }

  emit({ type: 'plan', plan, plannedCost, plannedBrainId })
  emit({ type: 'subtask', index: -1, label: '智能规划完成', status: 'success' })

  // ===== 4. conversation 意图：直接回复（规划积分已扣，计入 cost） =====
  if (plan.intent === 'conversation' || plan.deliverables.length === 0) {
    return { subtasks: [], totalCost: plannedCost + costBase, totalBeans: 0, reply: plan.reply, decisions: plan.decisions, foundationSummary: plan.foundation.direction.summary || '', projectHandoff: null }
  }

  // ===== 5. 依赖并发执行 =====
  // subtasks 按「交付物下标」收集，**最终按 deliverables 顺序输出**。
  // 为什么不能用 push：各分支（取消/失败/死锁/成功）在不同时刻 push，
  // 顺序取决于「谁先跑完」而非计划里的次序 —— 历史回显据此还原的
  // 「执行计划」卡片会与实际步序不符，subtask 事件的 index 也对不上号。
  const subtaskByIdx = new Map<number, Record<string, unknown>>()
  const results = new Map<string, Record<string, unknown>>()
  let totalCost = plannedCost + costBase  // 规划积分已扣，计入总成本（+ 循环路径已扣的规划费）
  let totalBeans = 0

  const deliverables = plan.deliverables.map((d) => ({ ...d, _done: false, _failed: false }))

  const tryRun = async (d: AgentDeliverable & { _done: boolean; _failed: boolean }): Promise<boolean> => {
    // B8: 取消感知 —— 执行前检查任务状态
    const curTask = await prisma.generationTask.findUnique({ where: { id: taskId }, select: { status: true } })
    if (curTask && curTask.status === 'CANCELLED') {
      d._failed = true
      emit({ type: 'subtask', index: deliverables.indexOf(d), label: d.title, status: 'failed', error: '任务已取消' })
      subtaskByIdx.set(deliverables.indexOf(d), { id: d.id, title: d.title, type: d.type, status: 'cancelled' })
      return false
    }
    emit({ type: 'subtask', index: deliverables.indexOf(d), label: `${d.title}（${d.type}）`, status: 'running', deliverableId: d.id || null, count: d.count && d.count >= 1 ? Math.min(d.count, 8) : 1 })
    try {
      const { result, cost, beans } = await runDeliverableWithRetry(d, { emit, userId, taskId, prompt, images: publicImages, sessionId, params, defaultTier: userPrefs.imageTier }, deliverables.indexOf(d))
      results.set(d.id || `task-${deliverables.indexOf(d)}`, result)
      totalCost += cost
      totalBeans += beans
      d._done = true
      subtaskByIdx.set(deliverables.indexOf(d), { id: d.id, title: d.title, type: d.type, status: result.videoPending ? 'processing' : 'success', ...result })
      emit({ type: 'subtask', index: deliverables.indexOf(d), label: d.title, status: result.videoPending ? 'processing' : 'success', deliverableId: d.id })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : '子任务失败'
      d._failed = true
      emit({ type: 'subtask', index: deliverables.indexOf(d), label: d.title, status: 'failed', error: msg, deliverableId: d.id || null })
      subtaskByIdx.set(deliverables.indexOf(d), { id: d.id, title: d.title, type: d.type, status: 'failed', error: msg })
      return false
    }
  }

  // 每轮执行所有依赖已就绪的任务（简化：按依赖串行推进，同层可并发）
  const pending = [...deliverables]
  let guard = 0
  while (pending.some((d) => !d._done && !d._failed) && guard < 20) {
    guard++
    const ready = pending.filter((d) => !d._done && !d._failed && (d.dependencies || []).every((dep) => results.has(dep)))
    if (ready.length === 0) {
      // 依赖死锁：把剩余标记失败
      pending.forEach((d) => { if (!d._done && !d._failed) { d._failed = true; subtaskByIdx.set(deliverables.indexOf(d), { id: d.id, title: d.title, type: d.type, status: 'failed', error: '前置任务未完成' }) } })
      break
    }
    await Promise.all(ready.map(tryRun))
  }

  // 按 deliverables 顺序展开 —— 与用户在计划卡上看到的推进次序一致
  const subtasks: Record<string, unknown>[] = deliverables
    .map((_, i) => subtaskByIdx.get(i))
    .filter((x): x is Record<string, unknown> => !!x)

  // ===== 6. projectHandoff：真建画布项目（B9） =====
  let projectHandoff: Record<string, unknown> | null = null
  if (plan.projectHandoff) {
    const h = plan.projectHandoff
    projectHandoff = {
      surface: h.surface,
      title: h.title,
      summary: h.summary,
      ratio: h.ratio,
    }
    // surface=canvas：服务端建 CanvasWorkflow，把完整计划物化为节点图（每个 deliverable 一个节点，依赖变成连线，结果写回节点 outputs，可重跑）
    if (h.surface === 'canvas') {
      try {
        // deliverable 类型 → 画布节点类型（audio 无对应节点类型，跳过）
        const NODE_TYPE: Record<string, { type: string; out: string }> = {
          text: { type: 'llm-chat', out: 'text' },
          image: { type: 'image-generate', out: 'imageUrl' },
          video: { type: 'video-generate', out: 'videoUrl' },
        }
        const nodeByDeliverable = new Map<string, string>() // deliverable.id → node.id
        const workflowNodes: Record<string, unknown>[] = []
        const connections: { id: string; sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }[] = []

        // 每个节点自动排版（按序横向 + 有依赖则靠右避免重叠）
        let col = 0
        for (const d of plan.deliverables.slice(0, 12)) {
          const nt = NODE_TYPE[d.type]
          if (!nt) continue
          const nodeId = `agent-${d.id || `task-${col}`}`
          const result = d.id ? subtasks.find((s) => s.id === d.id) : undefined
          const inputs: Record<string, unknown> = { prompt: d.prompt }
          if (d.model) inputs.model = d.model
          if (d.type === 'video' && d.ratio) inputs.aspectRatio = d.ratio
          const outputs: Record<string, unknown> = {}
          if (result?.status === 'success' && typeof result !== 'undefined') {
            const img = Array.isArray(result.imageUrls) ? String(result.imageUrls[0]) : result.imageUrl ? String(result.imageUrl) : null
            const vid = result.videoUrl ? String(result.videoUrl) : null
            const text = result.text ? String(result.text).slice(0, 4000) : null
            if (nt.type === 'image-generate' && img) outputs.imageUrl = img
            if (nt.type === 'video-generate' && vid) outputs.videoUrl = vid
            if (nt.type === 'llm-chat' && text) outputs.text = text
          }
          workflowNodes.push({
            id: nodeId,
            type: nt.type,
            label: d.title,
            category: nt.type === 'image-generate' ? 'image' : nt.type === 'video-generate' ? 'video' : 'llm',
            x: 120 + col * 280,
            y: Math.floor(col / 2) * 200,
            inputs,
            outputs,
          })
          nodeByDeliverable.set(d.id || '', nodeId)
          col++
        }

        // 依赖 → 连线（dep 的输出接到依赖它的节点）
        for (const d of plan.deliverables.slice(0, 12)) {
          const target = nodeByDeliverable.get(d.id || '')
          if (!target) continue
          const nt = NODE_TYPE[d.type]
          if (!nt) continue
          for (const dep of d.dependencies || []) {
            const src = nodeByDeliverable.get(dep)
            if (!src) continue
            connections.push({
              id: `conn-${src}-${target}`,
              sourceNodeId: src,
              sourcePort: NODE_TYPE[plan.deliverables.find((x) => x.id === dep)?.type || 'image']?.out || 'imageUrl',
              targetNodeId: target,
              targetPort: 'prompt',
            })
          }
        }

        const wf = await prisma.canvasWorkflow.create({
          data: {
            name: h.title.slice(0, 50),
            userId,
            nodes: workflowNodes.length ? JSON.parse(JSON.stringify(workflowNodes)) : [],
            connections: JSON.parse(JSON.stringify(connections)),
          },
        })
        projectHandoff.workflowId = wf.id
        projectHandoff.workflowNodeCount = workflowNodes.length
      } catch (err) {
        console.error('projectHandoff create canvas error (non-fatal):', err)
      }
    }
  }

  return { subtasks, totalCost, totalBeans, reply: plan.reply, decisions: plan.decisions, foundationSummary: plan.foundation.direction.summary || '', projectHandoff }
}


// ===== 主流程（新路径）：先工具循环，不支持则回落旧单次规划 =====
//
// 为什么要有这一层调度：第 2 期把「一次吐大 JSON」换成「小步动作 + 有界循环」，
// 但打 mock 训练时发现**并非池子里所有规划模型都吃 function calling** —— 有小模型会
// 直接忽略 tools 参数、照旧吐一段大 JSON，甚至上游会把 tools 字段当非法参数 400。
// 若一刀切只走循环，这些模型会集体变砖（用户看到「智能规划失败」）。
// 因此：先跑循环；一旦判定「这个模型不支持工具调用」（首轮无动作却吐大 JSON，或上游明确
// 报 tools 相关错误），就带着循环已扣的规划费回落到旧路径，语义等价、绝不二次扣费。
/**
 * 执行一批「已确认」的待执行项（confirm 模式的第二阶段）。
 *
 * 为什么单独抽一个函数、而不是复用 runAgent：
 *   - runAgent 会**重新规划**（再花一次规划费、且可能规划出不一样的东西）。
 *     用户在确认卡上看到的就是这些项，执行时就必须**照着这份清单跑**，
 *     不能重新理解一遍需求 —— 否则「我确认的是 A，结果出的是 B」。
 *   - 这里只做「依赖拓扑 + 并发执行」，与 legacy 路径的执行循环同构。
 *
 * 依赖关系仍按 dependencies 处理：没依赖的并发跑（多张图不排队），
 * 有依赖的等前置完成（如"基于第 1 张再改"）。
 */
export async function executePendingActions(opts: {
  userId: string
  taskId: string
  prompt: string
  images?: string[]
  sessionId?: string | null
  params?: Record<string, unknown>
  defaultTier?: string | null
  pendingActions: import('@/lib/agent-pending').PendingAction[]
  emit: AgentEmit
}): Promise<{ subtasks: Record<string, unknown>[]; totalCost: number; totalBeans: number }> {
  const { userId, taskId, prompt, images, sessionId, params, defaultTier, pendingActions, emit } = opts
  const publicImages = images
  await assertAgentTaskActive(taskId)

  // ===== 重建会话素材池（硬化清单 §3.4 / §2.4）=====
  //
  // 为什么必须在这里重建：poolByAlias（图片N/素材N → 公网 URL）是**规划期**
  // 由 agent-tool-loop 构建的内存对象，不会随 pendingActions 落库。
  // 确认执行是一个新的进程内调用，若不重建，pendingActions 里模型写的
  // assetIds:["图片1"] 会在 resolveReferenceImages 里查不到 → 静默退化成
  // 文生图（用户确认的是"基于我的图改"，实际拿到的是凭空重画）。
  //
  // 与规划期同口径：loadSessionAssetPool 只读 chat_messages（此时本轮产物
  // 尚未落库，所以池子内容与规划时一致），再逐条公网化；坏条目跳过不阻断。
  let poolByAlias: Map<string, string> | undefined
  if (sessionId) {
    try {
      const pool = await loadSessionAssetPool(sessionId)
      poolByAlias = new Map()
      for (const a of [...pool.uploaded, ...pool.generated]) {
        try {
          const [pub] = await publicizeReferenceImages([a.url], userId)
          if (pub) poolByAlias.set(a.alias, pub)
        } catch {
          // 站内素材已过期（TTL 到期）→ 跳过；模型引用时会退回本轮上传图
        }
      }
    } catch {
      // 池子加载失败不阻断执行：退化为"未指定参考图走本轮上传图"的旧行为
      poolByAlias = undefined
    }
  }

  const subtasks: Record<string, unknown>[] = []
  let totalCost = 0
  let totalBeans = 0

  // 待执行项 → deliverable：确认卡上的字段原样带过去，绝不在执行期改动用户看过的东西。
  const items = pendingActions.map((p, i) => ({
    d: {
      id: p.id,
      title: p.title,
      type: p.kind === 'image' ? 'image' : p.kind === 'video' ? 'video' : p.kind === 'audio' ? 'audio' : 'text',
      model: p.modelId,
      prompt: p.prompt,
      count: p.count,
      ratio: p.ratio,
      quality: p.quality,
      resolution: p.resolution,
      seconds: p.seconds,
      voice: p.voice,
      dependencies: p.dependencies,
      assetIds: p.assetIds,
    } as AgentDeliverable,
    index: i,
    done: false,
    failed: false,
  }))

  const doneIds = new Set<string>()
  const tryRun = async (item: (typeof items)[number]) => {
    const d = item.d
    await assertAgentTaskActive(taskId)
    emit({ type: 'subtask', index: item.index, label: `${d.title}（${d.type}）`, status: 'running', deliverableId: d.id, count: d.count })
    try {
      const { result, cost, beans } = await runDeliverableWithRetry(
        d,
        { emit, userId, taskId, prompt, images: publicImages, sessionId, params, defaultTier, deliverableId: d.id, poolByAlias },
        item.index,
      )
      totalCost += cost
      totalBeans += beans
      item.done = true
      emit({ type: 'subtask', index: item.index, label: d.title, status: result.videoPending ? 'processing' : 'success', deliverableId: d.id })
      subtasks.push({ id: d.id, title: d.title, type: d.type, status: result.videoPending ? 'processing' : 'success', ...result })
    } catch (err) {
      if (err instanceof AgentCancelledError) {
        item.failed = true
        emit({ type: 'cancelled', taskId, subtasks })
        throw err
      }
      const msg = err instanceof Error ? err.message : '生成失败'
      item.failed = true
      emit({ type: 'subtask', index: item.index, label: d.title, status: 'failed', error: msg, deliverableId: d.id })
      subtasks.push({ id: d.id, title: d.title, type: d.type, status: 'failed', error: msg })
    }
    if (d.id) doneIds.add(String(d.id))
  }

  // 依赖拓扑 + 同层并发（与 legacy 执行循环同口径）
  const pending = [...items]
  let guard = 0
  while (pending.some((x) => !x.done && !x.failed) && guard < 20) {
    guard++
    await assertAgentTaskActive(taskId)
    const ready = pending.filter((x) => {
      if (x.done || x.failed) return false
      const deps = x.d.dependencies || []
      return deps.every((dep) => doneIds.has(String(dep)))
    })
    if (ready.length === 0) {
      pending.forEach((x) => {
        if (!x.done && !x.failed) {
          x.failed = true
          subtasks.push({ id: x.d.id, title: x.d.title, type: x.d.type, status: 'failed', error: '前置任务未完成' })
        }
      })
      break
    }
    await Promise.all(ready.map(tryRun))
  }

  return { subtasks, totalCost, totalBeans }
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const { runAgentToolLoop, ToolLoopUnsupportedError } = await import('@/lib/agent-tool-loop')

  const candidates = await planningCandidates()
  if (candidates.length === 0) {
    throw new Error('没有可用的规划模型（TEXT），请配置后再使用智能模式')
  }
  const userPrefs = await getAgentPreferences(input.userId)
  // confirm 模式：执行类动作先入队等确认，不真跑（见 agent-pending.ts 的设计说明）
  const pendingActions: import('@/lib/agent-pending').PendingAction[] = []
  const executeMode = userPrefs.executeMode

  try {
    const loop = await runAgentToolLoop({
      emit: input.emit,
      userId: input.userId,
      taskId: input.taskId,
      prompt: input.prompt,
      images: input.images,
      sessionId: input.sessionId,
      skillIds: input.skillIds,
      candidates: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        modelName: c.modelName || c.name,
        type: c.type,
        supportsVision: c.supportsVision,
        // 上下文窗口：供工具循环按模型能力算历史预算（不写死条数）
        contextWindow: c.contextWindow,
        // 思考模型的判定依据（metadata.think）→ 决定是否下发 reasoning_effort
        metadata: c.metadata,
        provider: {
          baseUrl: c.provider.baseUrl,
          apiKey: c.provider.apiKey,
          adapterId: c.provider.adapterId,
          configJson: c.provider.configJson,
        },
      })),
      defaultTier: userPrefs.imageTier,
      params: input.params,
      executeMode,
      pendingActions,
      revision: input.revision ?? null,
      checkpoint: input.checkpoint ?? null,
      onCheckpoint: input.onCheckpoint,
      // 复用旧路径的子任务执行体（排队/计费/mock/参考图解析全在这里面），不另造一套。
      runDeliverable: (d, ctx) => runDeliverableWithRetry(d, ctx, 0),
    })

    return {
      subtasks: loop.subtasks,
      totalCost: loop.totalCost,
      totalBeans: loop.totalBeans,
      reply: loop.reply,
      decisions: loop.decisions,
      askQuestions: loop.askQuestions,
      // 循环路径没有单独的 foundation 摘要：用 finish/decisions 拼一句极简摘要供复盘使用
      foundationSummary: loop.decisions.map((d) => `${d.label}=${d.value}`).join('；'),
      projectHandoff: null,
      pendingActions: loop.pendingActions,
      agentTrace: loop.agentTrace,
      path: 'tool-loop',
      checkpoint: loop.checkpoint,
    }
  } catch (err) {
    // 上游明确拒 tools（首轮零进展）→ 回落旧路径；其它错误照常上抛，避免重复跑一遍徒增等待
    if (err instanceof ToolLoopUnsupportedError && !input.checkpoint) {
      console.warn('[agent] 工具循环不支持（上游拒 tools 参数），回落旧单次规划路径：', err.message)
      // 打点：这条回落还有没有真实用量，决定 2.2 能不能删旧路径（不能凭印象决定）
      const legacy = await runAgentLegacy(input, 0)
      return { ...legacy, path: 'legacy' as const }
    }
    throw err
  }
}
