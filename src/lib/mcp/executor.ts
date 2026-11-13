import { getPrisma } from '@/lib/prisma'
import { toUpstreamError } from '@/lib/network-error'
import {
  topologicalSort,
  resolveInputs,
  executeNode,
  ExecutionEvent,
} from '@/lib/canvas-executor'
import type { ExecutionNode, ExecutionConnection } from '@/lib/canvas-executor'
import { ModelType } from '@prisma/client'
import { effectivePoints, roundPoints } from '@/lib/pricing'
import { tryConsumeFreeQuota, releaseFreeQuota, getFreeQuotaStatus } from '@/lib/free-quota'
import { deductBeans as walletDeductBeans, refundPoints as walletRefundPoints, refundBeans as walletRefundBeans, openHold, settleHoldWithRefund, deductRunCharge as walletDeductRunCharge } from '@/lib/billing/wallet'
import { checkFreeImagePass, consumeFreeImagePass, releaseFreeImagePass } from '@/lib/promotions/free-image-pass'
import { planNodeCharge, nodeChargeInputs, CATEGORY_CANVAS_NODE } from '@/lib/billing/billing-plans'
import { resolveAvailableBalance } from '@/lib/billing/team'
import { findFallbackModel, resolveChargeModel } from '@/lib/model-catalog'
import { planningCandidates } from '@/lib/agent-config'
import { isAutoLlm } from '@/lib/auto-llm'
import { withGatePhaseReporter } from '@/lib/concurrency'
import { toDetailJson, pickRequestDetail, pickResponseDetail } from '@/lib/usage-detail'
import { outputKindFromModelType } from '@/lib/media-kinds'
import { batchCopyPosition, DEFAULT_BATCH_LAYOUT } from '@/lib/canvas-batch'
import { decodeSize } from '@/lib/image-sizes'
import { buildNineGridLoopPrompt, buildNativeGifPrompt, normalizeOutputMode, parseNineGridScript } from '@/lib/nine-grid-loop'

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v))


function genNodeId(): string {
  return `node-${crypto.randomUUID().slice(0, 8)}`
}

/** 图片生成记录里落库的提示词：九宫格节点落「拼好的最终提示词」，普通生图落原提示词。 */
function imagePromptForLog(node: ExecutionNode, inputs: Record<string, unknown>): string {
  if (node.type === 'nine-grid-loop') {
    try {
      const script = String(inputs.script ?? node.inputs.script ?? '').trim()
      const grid = inputs.grid ?? node.inputs.grid
      const outputMode = normalizeOutputMode(inputs.outputMode ?? node.inputs.outputMode)
      const build = outputMode === 'native-gif' ? buildNativeGifPrompt : buildNineGridLoopPrompt
      if (script) {
        const parsed = parseNineGridScript(script)
        const hasSections = Boolean(parsed.character || parsed.scene || parsed.actions)
        return build(
          hasSections
            ? { ...parsed, grid }
            : {
              brief: script
                .split(/\r?\n/)
                .filter((line) => !/^\s*(画风|风格|宫格|宫格规格)\s*[:：]/.test(line))
                .join('\n')
                .trim() || script,
              style: parsed.style,
              grid,
            },
        )
      }
      return build({
        character: String(inputs.character ?? node.inputs.character ?? ''),
        scene: String(inputs.scene ?? node.inputs.scene ?? ''),
        actions: String(inputs.actions ?? node.inputs.actions ?? ''),
        style: String(inputs.style ?? node.inputs.style ?? ''),
        grid,
      })
    } catch {
      return ''
    }
  }
  return String(inputs.prompt || node.inputs.prompt || '')
}

/**
 * 生成扣费的展示文案。
 * 用户只能看到顶层这条流水（节点级是内部记账，不对外展示），所以要把模型名带上，
 * 否则用户只知道扣了钱、不知道用的什么模型。多模型时列前两个 + 「等 N 个」。
 */
function chargeDescription(modelNames: Set<string>): string {
  const names = [...modelNames]
  if (names.length === 0) return '生成扣费'
  if (names.length <= 2) return `生成扣费 · ${names.join('、')}`
  return `生成扣费 · ${names.slice(0, 2).join('、')} 等 ${names.length} 个模型`
}
function genConnId(): string {
  return `conn-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * 终态收口（Q-D03）：退「预扣 - 实耗」差额 + 置 hold SETTLED，同一事务原子完成。
 * 以前是「退款 .catch 吞错 → 无条件 settleHold」：退款一旦失败，对账兜底永不重试，差额永久丢失。
 * 现在退款失败整体回滚、hold 保持 OPEN，由 reconcileHold 按同一差额重试（hold 状态幂等，不会双退）。
 * canvasRun 为 null（无 run 无 hold 的执行入口）时退化为尽力而为的独立退款。
 */
async function settleBudgetRemainder(args: {
  canvasRun: { id: string } | null
  userId: string
  budgetPoints: number
  consumedPoints: number
  budgetBeans: number
  consumedBeans: number
  label: string
}) {
  const refundPoints = roundPoints(args.budgetPoints - args.consumedPoints)
  const refundBeans = roundPoints(args.budgetBeans - args.consumedBeans)
  if (!args.canvasRun) {
    if (refundPoints > 0) {
      await walletRefundPoints({ userId: args.userId, amount: refundPoints, description: `画布${args.label}退款（未消耗部分）` })
        .catch((e) => console.error(`画布${args.label}退款积分失败:`, e))
    }
    if (refundBeans > 0) {
      await walletRefundBeans({ userId: args.userId, amount: refundBeans, description: `画布视频节点${args.label}退款（未消耗部分）` })
        .catch((e) => console.error(`画布视频节点${args.label}退款豆失败:`, e))
    }
    return
  }
  await settleHoldWithRefund({
    runId: args.canvasRun.id,
    userId: args.userId,
    refundPoints,
    refundBeans,
    pointsDescription: `画布${args.label}退款（未消耗部分）`,
    beansDescription: `画布视频节点${args.label}退款（未消耗部分）`,
  }).catch((e) => console.error(`画布${args.label}退款失败（hold 保持 OPEN，交由对账重试）:`, e))
}

// 后端就地展开批量副本：主本(index 0) + 副本(1..N-1) 一次执行、同一套语块
// 复用前端 expandBatchNode 的克隆逻辑（画布节点副本 + 共享输入连线）
type BatchCopy = ExecutionNode & { x: number; y: number; batch: { sourceId: string; index: number } }

/** Number(v) 归一到有限值，否则给 0（用于把节点宽高拼成 decodeSize 需要的 "WxH"） */
function finiteOrZero(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function expandBatchCopies(
  batchNode: ExecutionNode,
  N: number,
  nodes: ExecutionNode[],
  connections: ExecutionConnection[]
): { copies: BatchCopy[]; conns: ExecutionConnection[]; mainConnId: string } | null {
  const triggerConn = connections.find((c) => c.sourceNodeId === batchNode.id && c.sourcePort === 'prompts')
  if (!triggerConn) return null
  const targetNode = nodes.find((n) => n.id === triggerConn.targetNodeId)
  if (!targetNode) return null
  const tn = targetNode as ExecutionNode & { x?: number; y?: number }
  const copies: BatchCopy[] = []
  const conns: ExecutionConnection[] = []
  for (let i = 1; i < N; i++) {
    const copyId = genNodeId()
    copies.push({
      ...targetNode,
      id: copyId,
      label: `${targetNode.label} (${i + 1})`,
      // 位置计算收敛到 lib/canvas-batch（唯一实现，杜绝与前端漂移）：
      // 原来这里硬编码 +40/+20/+120，而前端按节点真实高度排 —— 两边算出的位置不同，
      // 同一个 N 在前端显示时会重叠错位（INV-2026-0919-04 的 D-01）。
      ...batchCopyPosition({ x: tn.x ?? 200, y: tn.y ?? 100 }, i, DEFAULT_BATCH_LAYOUT),
      inputs: { ...(targetNode.inputs || {}) },
      batch: { sourceId: batchNode.id, index: i },
    })
    conns.push({ id: genConnId(), sourceNodeId: batchNode.id, sourcePort: 'prompts', targetNodeId: copyId, targetPort: triggerConn.targetPort, index: i })
    // 克隆共享输入连线（如 产品图→参考图），每个副本拿到同一组上游输入
    connections
      .filter((c) => c.targetNodeId === targetNode.id && !(c.sourceNodeId === batchNode.id && c.sourcePort === 'prompts'))
      .forEach((c) => conns.push({ ...c, id: genConnId(), targetNodeId: copyId }))
  }
  return { copies, conns, mainConnId: triggerConn.id }
}

export type RunGraphErrorCode = 'INSUFFICIENT_POINTS' | 'INSUFFICIENT_BEANS' | 'CANCELLED' | 'NOT_FOUND'

export class RunGraphError extends Error {
  code: RunGraphErrorCode
  status: number
  constructor(code: RunGraphErrorCode, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface RunGraphOptions {
  userId: string
  nodes: ExecutionNode[]
  connections: ExecutionConnection[]
  seedOutputs?: Record<string, Record<string, unknown>>
  executeNodeIds?: string[]
  runId?: string
  workflowName?: string
  /** 执行入口：canvas / tool / batch / mcp / agent（写进 CanvasRun.surface） */
  surface?: string
  /** 入口内对象 id：工具箱填 tool.id（写进 CanvasRun.surfaceId） */
  surfaceId?: string
  /** 成果节点 id 列表：只有这些节点的产出算最终成果，恢复时据此提取 */
  resultNodeIds?: string[]
}

export interface RunGraphResult {
  runId: string
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED'
  outputs: Record<string, Record<string, unknown>>
  error?: string
  costPoints: number
  costBeans: number
}

/**
 * 共享画布执行核心：从 /api/canvas/execute 抽取（route 传 SSE 流、MCP 传事件聚合回调）。
 * 计费链路（预估→预扣→hold→节点记账→差额退款→结算）完整保留在此层。
 * 调用方需先自行完成鉴权与用户存在性检查。
 */
export async function runCanvasGraph(
  opts: RunGraphOptions,
  onEvent?: (event: ExecutionEvent) => Promise<void> | void
): Promise<RunGraphResult> {
  const { userId, nodes, connections, seedOutputs, executeNodeIds, runId, workflowName, surface, surfaceId, resultNodeIds } = opts

  const prisma = await getPrisma()

  // 增量执行：只跑 executeNodeIds 里的节点，其余节点作为输入源（输出从 seedOutputs 提供）
  const executeIdSet = executeNodeIds && Array.isArray(executeNodeIds) ? new Set(executeNodeIds) : null

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    throw new RunGraphError('NOT_FOUND', '用户不存在', 404)
  }

  // ===== P6: 画布任务持久化 =====
  // runId 提供则查归属：存在则校验状态（暂停/取消/重试续跑），不存在则视为新 run 创建
  let canvasRun = null
  if (runId) {
    canvasRun = await prisma.canvasRun.findFirst({ where: { id: runId, userId } })
    if (canvasRun && canvasRun.status === 'CANCELLED') {
      throw new RunGraphError('CANCELLED', '该执行已被取消', 400)
    }
  }
  if (!canvasRun) {
    canvasRun = await prisma.canvasRun.create({
      data: {
        id: runId || undefined,
        userId,
        workflowName: workflowName || '未命名工作流',
        surface: surface || 'canvas',
        surfaceId: surfaceId || undefined,
        resultNodeIds: resultNodeIds ? toJson(resultNodeIds) : undefined,
        nodes: toJson(nodes),
        connections: toJson(connections),
        seedOutputs: seedOutputs ? toJson(seedOutputs) : undefined,
        executedNodeIds: executeNodeIds || undefined,
        status: 'RUNNING',
      },
    })
  }

  // Pre-compute total point cost based on LLM/image/video nodes (增量执行时只统计本次要跑的节点)
  // 预扣按节点实际选的模型计价（未选/模型无效时按类型兜底取第一个激活模型，宁可多扣、结束时退差额）。
  // 图片节点按档位价（billing-plans.planNodeCharge）与节点实扣保持一致，杜绝"高配档位少收钱"。
  let totalCost = 0
  let totalBeans = 0
  const nodeModelMap = new Map<string, { id: string; type: string; costPoints: number; videoCost?: number | null; discount?: number | null; isFree?: boolean; dailyUserFreeQuota?: number | null; metadata?: Record<string, unknown> | null }>()
  // 每日免费额度：预扣阶段先扣掉「有剩余免费额度」的节点，避免用户积分不足却本可免费使用；
  // 实际是否命中在执行时原子判定（本缓存只用于预扣估算，避免同一模型重复查库）。
  const quotaRemainCache = new Map<string, number>()
  // 本次实际用到的模型名（去重）：写进顶层扣费描述里。
  // 顶层「生成扣费」是用户唯一能看到的那条流水（节点级记录是内部记账、不对外展示），
  // 不带模型名的话用户只知道扣了钱、不知道用的什么模型。
  const chargedModelNames = new Set<string>()
  for (const node of nodes) {
    if (executeIdSet && !executeIdSet.has(node.id)) continue
    if (node.type === 'llm-chat' || node.type === 'image-generate' || node.type === 'nine-grid-loop' || node.type === 'video-generate') {
      const type: ModelType = node.type === 'video-generate' ? 'VIDEO' : (node.type === 'image-generate' || node.type === 'nine-grid-loop') ? 'IMAGE' : 'TEXT'
      const modelId = node.inputs?.model ? String(node.inputs.model) : undefined
      const model = await resolveChargeModel(type, modelId)
      if (!model) continue
      const meta = (model.metadata as Record<string, unknown> | null) ?? null
      chargedModelNames.add(model.name)
      nodeModelMap.set(node.id, {
        id: model.id,
        type,
        costPoints: model.costPoints,
        videoCost: model.videoCost,
        discount: model.discount,
        isFree: model.isFree,
        dailyUserFreeQuota: model.dailyUserFreeQuota,
        metadata: meta,
      })
      if ((await checkFreeImagePass({ id: model.id, type, dailyUserFreeQuota: model.dailyUserFreeQuota }, user, user.id)).free) {
        continue
      }
      // 计费因子统一走 nodeChargeInputs：这里曾是「漏传 resolution」的漏斗，
      // 导致预扣算成 0 豆、节点按 768P 实扣 300 豆，差额被静默吃掉（见 billing-plans 注释）。
      const charge = planNodeCharge(
        type,
        { costPoints: model.costPoints, videoCost: model.videoCost, discount: model.discount, isFree: model.isFree, metadata: meta },
        nodeChargeInputs(node.inputs),
      )
      // 每日免费额度：该模型今日还有剩余额度时，本节点预扣按 0 计（执行时再原子占用）
      if ((model.dailyUserFreeQuota ?? 0) > 0) {
        // 缓存 key 必须含档位：freeQuotaMaxTier 让不同档位的剩余额度不同，
        // 只按 model.id 缓存会把「1K 有额度」误用到「4K 无额度」的节点上。
        const tierForQuota = type === 'IMAGE' ? decodeSize(`${finiteOrZero(node.inputs?.width)}x${finiteOrZero(node.inputs?.height)}`)?.tier : undefined
        const quotaKey = `${model.id}@${tierForQuota ?? '-'}`
        let remain = quotaRemainCache.get(quotaKey)
        if (remain === undefined) {
          remain = (await getFreeQuotaStatus(model, user.id, tierForQuota)).remaining
          quotaRemainCache.set(quotaKey, remain)
        }
        if (remain > 0) {
          quotaRemainCache.set(quotaKey, remain - 1)
          continue
        }
      }
      totalCost += charge.points
      totalBeans += charge.beans
    }
  }

  // 团队共享池：按出资人（老板）余额判定，否则成员余额 0 会被提前拒绝
  const availBal = await resolveAvailableBalance(user.id)
  if (availBal.points < totalCost) {
    throw new RunGraphError('INSUFFICIENT_POINTS', availBal.isTeam ? '团队积分不足，请联系管理员充值' : '积分不足', 402)
  }

  if (availBal.beans < totalBeans) {
    throw new RunGraphError(
      'INSUFFICIENT_BEANS',
      availBal.isTeam
        ? `团队豆不足，视频节点需要 ${totalBeans} 豆，请联系管理员充值`
        : `豆不足，视频节点需要 ${totalBeans} 豆，请前往个人中心充值`,
      402,
    )
  }

  // ===== 画布资金账本（hold）：预扣落账，崩溃/重启后由惰性对账兜底退款 =====
  // 注意：hold 必须在预扣成功后才建，且要拿到 canvasRun.id（runId 未知时先落一次预扣再补建）。
  let holdId: string | null = null

  // 预扣：积分 + 豆同一事务（Q-D01），任一失败整体回滚，不再手工「豆失败退回积分」
  if (totalCost > 0 || totalBeans > 0) {
    try {
      await walletDeductRunCharge({ userId: user.id, points: totalCost, beans: totalBeans, description: chargeDescription(chargedModelNames), runId: canvasRun.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : '余额不足'
      // wallet 的条件扣减失败信息已区分币种（积分不足 / 豆不足），按文案选错误码
      const code = /积分不足/.test(message) ? 'INSUFFICIENT_POINTS' : 'INSUFFICIENT_BEANS'
      throw new RunGraphError(code, message, 402)
    }
  }
  // 预扣成功才建 hold（runId 此时已确定：canvasRun 在上面查/建分支已存在）
  if (canvasRun && (totalCost > 0 || totalBeans > 0)) {
    const hold = await openHold(user.id, canvasRun.id, totalCost, totalBeans)
    holdId = (hold as { id?: string } | null)?.id ?? null
  }

  // ===== 计费模型：顶层预扣 = 预算池，节点执行时从池内记账，结束时按差额退款 =====
  // 节点内扣费先记入 pending，节点成功后才累加进 consumed（节点抛错即丢弃 pending，
  // 未消耗部分随差额退款退回）；批量展开追加的副本预扣并入 budgetPoints。
  let budgetPoints = totalCost
  // 预扣预算池：批量展开副本可能在执行中途追加预扣，所以用 let（与 budgetPoints 同理）
  let budgetBeans = totalBeans
  let consumedPoints = 0
  let consumedBeans = 0
  let nodePendingPoints = 0
  let nodePendingBeans = 0
  // 本节点已占用的免费额度模型 id（节点失败时回滚，成功时保留）
  // 本节点已占用的免费额度模型 id 集合。
  // 用 Set 而不是单个 id：一个节点可能多次打上游（如自定义节点里先 LLM 再生图），
  // 单值会被后一次覆盖，失败时只归还最后一个，前一个就白损失了。
  let nodePendingFreeQuotaModels = new Set<string>()
  // 本节点已占用的时长券名额（台账行 id）；节点失败时删除，成功时保留计入统计。
  let nodePendingPassUsageIds = new Set<string>()

  // 统一事件出口：route 层写 SSE 流，MCP 层聚合
  const emit = async (event: ExecutionEvent) => {
    try {
      await onEvent?.(event)
    } catch {
      // 消费方（如已断开的 SSE 流）异常不影响执行与结算
    }
  }

  try {
    const sorted = topologicalSort(nodes, connections)
    const outputs: Record<string, Record<string, unknown>> = { ...(seedOutputs || {}) }

    // 动态工作队列：批量节点执行后就地展开副本并入队，主本+副本一次跑完
    const queue = [...sorted]
    while (queue.length > 0) {
      // ===== P6: 执行前检查 run 状态（暂停/取消由 runs API 更新） =====
      if (canvasRun) {
        const cur = await prisma.canvasRun.findUnique({ where: { id: canvasRun.id }, select: { status: true } })
        if (cur && cur.status === 'CANCELLED') {
          await emit({ type: 'cancelled', runId: canvasRun.id })
          // 差额退款：只退预算池里未消耗的部分
          await settleBudgetRemainder({ canvasRun, userId: user.id, budgetPoints, consumedPoints, budgetBeans, consumedBeans, label: '取消' })
          return { runId: canvasRun.id, status: 'CANCELLED', outputs, costPoints: consumedPoints, costBeans: consumedBeans }
        }
        if (cur && cur.status === 'PAUSED') {
          await emit({ type: 'paused', runId: canvasRun.id })
          // 暂停同样退未消耗部分（恢复续跑时会重新预扣）
          await settleBudgetRemainder({ canvasRun, userId: user.id, budgetPoints, consumedPoints, budgetBeans, consumedBeans, label: '暂停' })
          return { runId: canvasRun.id, status: 'PAUSED', outputs, costPoints: consumedPoints, costBeans: consumedBeans }
        }
      }

      const node = queue.shift()!
      // 增量执行：跳过非本次要跑的节点，其输出已由 seedOutputs 提供
      if (executeIdSet && !executeIdSet.has(node.id)) continue
      await emit({ type: 'nodeStart', nodeId: node.id })

      const inputs = resolveInputs(node, connections, outputs)

      const findModel = async (type = 'TEXT', modelId?: string) => {
        const auto = isAutoLlm(modelId) && (type === 'TEXT' || type === 'VISION')
        const autoModel = auto ? (await planningCandidates())[0] ?? null : null
        // 指定模型失效（被删除/停用）时按类型回退，避免工具因历史模型 id 直接执行失败
        const model = (modelId && !auto
          ? await prisma.modelConfig.findFirst({
              where: { id: modelId, isActive: true },
              include: { provider: true },
            })
          : null)
          ?? autoModel
          // 回退优先级：同类型里优先选 provider 已配 API Key、且 adapter 具备该能力钩子的模型，
          // 避免落到未配置 Key 或「不支持生图」的供应商上直接失败
          ?? await findFallbackModel(type as ModelType)
        if (!model || !model.provider) return null
        return {
          id: model.id,
          modelName: model.modelName || model.name,
          type: model.type,
          costPoints: effectivePoints(model.costPoints, model.discount, model.isFree),
          videoCost: model.videoCost,
          discount: model.discount,
          isFree: model.isFree,
          dailyUserFreeQuota: model.dailyUserFreeQuota,
          dailyPlatformFreeQuota: model.dailyPlatformFreeQuota,
          supportsVision: model.supportsVision || model.type === 'VISION',
          metadata: (model.metadata as Record<string, unknown> | null) ?? undefined,
          provider: {
            baseUrl: model.provider.baseUrl,
            apiKey: model.provider.apiKey,
            adapterId: model.provider.adapterId,
            configJson: (model.provider.configJson as Record<string, unknown> | null) ?? undefined,
          },
        }
      }

      const findModelCandidates = async (type = 'TEXT') => {
        if (type !== 'TEXT' && type !== 'VISION') return []
        const rows = await planningCandidates()
        return rows.map((model) => ({
          id: model.id,
          modelName: model.modelName || model.name,
          type: model.type,
          costPoints: effectivePoints(model.costPoints, model.discount, model.isFree),
          videoCost: model.videoCost,
          discount: model.discount,
          isFree: model.isFree,
          dailyUserFreeQuota: model.dailyUserFreeQuota,
          dailyPlatformFreeQuota: model.dailyPlatformFreeQuota,
          supportsVision: model.supportsVision || model.type === 'VISION',
          metadata: (model.metadata as Record<string, unknown> | null) ?? undefined,
          provider: {
            baseUrl: model.provider.baseUrl,
            apiKey: model.provider.apiKey,
            adapterId: model.provider.adapterId,
            configJson: (model.provider.configJson as Record<string, unknown> | null) ?? undefined,
          },
        }))
      }

      const deductPoints = async (
        points: number,
        description: string,
        model?: { id: string; type?: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null; metadata?: Record<string, unknown> | null },
        tier?: string | null,
      ) => {
        if (model) {
          const pass = await consumeFreeImagePass({
            model: { id: model.id, type: model.type, dailyUserFreeQuota: model.dailyUserFreeQuota },
            user,
            userId: user.id,
            source: 'canvas',
            runId: canvasRun.id,
          })
          if (pass.free) {
            for (const usageId of pass.usageIds) nodePendingPassUsageIds.add(usageId)
            await prisma.pointsLog.create({
              data: {
                userId: user.id,
                amount: 0,
                type: 'DEDUCTION',
                description: `${description}（生图时长券）`,
                category: CATEGORY_CANVAS_NODE,
                runId: canvasRun.id,
              },
            })
            return
          }
        }
        // 每日免费额度：命中则本次不计费（不写扣费流水，也不计入预算池消耗）
        // tier 参与 freeQuotaMaxTier 判定：超出免费额度档位上限时不走免费，按正常计费
        if (model && await tryConsumeFreeQuota(model, user.id, tier)) {
          nodePendingFreeQuotaModels.add(model.id)
          await prisma.pointsLog.create({
            data: {
              userId: user.id,
              amount: 0,
              type: 'DEDUCTION',
              description: `${description}（每日免费额度）`,
              category: CATEGORY_CANVAS_NODE,
              runId: canvasRun.id,
            },
          })
          return
        }
        // 预扣即预算池，这里只记账（写流水，带 category='canvas-node' 标记，不参与真实扣款统计）并暂存 pending。
        // 金额必须为负（DEDUCTION 正数会被当成 +N 加分显示）
        await prisma.pointsLog.create({
          data: {
            userId: user.id,
            amount: -points,
            type: 'DEDUCTION',
            description,
            category: CATEGORY_CANVAS_NODE,
            runId: canvasRun.id,
          },
        })
        nodePendingPoints += points
      }

      const deductBeans = async (
        beans: number,
        description: string,
        model?: { id: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null; metadata?: Record<string, unknown> | null },
        tier?: string | null,
      ) => {
        // 每日免费额度：命中则本次不计费（豆也不扣）
        if (model && await tryConsumeFreeQuota(model, user.id, tier)) {
          nodePendingFreeQuotaModels.add(model.id)
          await prisma.beansLog.create({
            data: { userId: user.id, amount: 0, type: 'DEDUCTION', description: `${description}（每日免费额度）`, category: CATEGORY_CANVAS_NODE, runId: canvasRun.id },
          })
          return
        }
        // 豆已在顶层预扣，这里只记账（写流水，带 category='canvas-node'）并暂存 pending
        await prisma.beansLog.create({
          data: { userId: user.id, amount: -beans, type: 'DEDUCTION', description, category: CATEGORY_CANVAS_NODE, runId: canvasRun.id },
        })
        nodePendingBeans += beans
      }

      // 计时放在 try 之外：catch 分支写失败日志时也要用到
      const nodeStartedAt = Date.now()
      // 相位上报：节点内部打上游时会经过 withUpstreamGate，把「排队 → 发出」的
      // 真实时刻回传成 nodePhase 事件，前端据此显示「等待派发 / 生成中 + 计时」。
      // 只在相位真正变化时上报，避免同一节点多次打上游时刷屏。
      // 单调不回退：429/5xx 重试会重新进闸门，若把相位打回 queued，
      // 前端会看到「生成中 → 等待派发」并重置计时，反而像卡住了。
      let reachedRunning = false
      const reportPhase = (phase: 'queued' | 'running') => {
        if (phase === 'queued' && reachedRunning) return
        if (phase === 'running') {
          if (reachedRunning) return
          reachedRunning = true
        }
        void emit({ type: 'nodePhase', nodeId: node.id, phase, at: Date.now() })
      }
      try {
        nodePendingPoints = 0
        nodePendingBeans = 0
        nodePendingFreeQuotaModels = new Set<string>()
        nodePendingPassUsageIds = new Set<string>()
        const output = await withGatePhaseReporter(reportPhase, () =>
          executeNode(node, inputs, {
            prisma,
            userId: user.id,
            emit,
            findModel,
            findModelCandidates,
            deductPoints,
            deductBeans,
            getNodeSpec: async (nodeType: string) => {
              const spec = await prisma.canvasNodeSpec.findFirst({ where: { nodeType } })
              return spec ? { codeSchema: spec.codeSchema } : null
            },
          }),
        )
        outputs[node.id] = output
        // 节点成功：本节点扣费从 pending 落账为实际消耗
        // 先把金额存下来再清零——下面写 ApiUsageLog 要用它。
        // 之前先清零后写日志，导致运维面板「调用记录」里扣除积分永远是 0
        // （而「积分与模型」读的是 pointsLog，所以那边是对的，两边对不上）。
        const spentPoints = nodePendingPoints
        // 本节点扣的豆（视频节点按豆计费、pointsDeducted=0）。必须单独取出来，
        // 否则视频调用在调用记录里永远显示「扣除 0」，看不出真实消耗。
        const spentBeans = nodePendingBeans
        consumedPoints += nodePendingPoints
        consumedBeans += nodePendingBeans
        nodePendingPoints = 0
        nodePendingBeans = 0
        await emit({
          type: 'nodeOutput',
          nodeId: node.id,
          output,
          // 完成态卡片要展示「用什么模型 / 花了多久 / 扣了多少」——
          // 这三样只在执行期可得，随事件带出去，否则成果卡片完成后只剩一个泛化 label。
          meta: {
            modelName: await (async () => {
              const m = await findModel(
                node.type === 'video-generate' ? 'VIDEO' : (node.type === 'image-generate' || node.type === 'nine-grid-loop') ? 'IMAGE' : node.type === 'audio-generate' ? 'AUDIO' : 'TEXT',
                node.inputs?.model ? String(node.inputs.model) : undefined,
              ).catch(() => null)
              return m ? (m.modelName || undefined) : undefined
            })(),
            durationMs: Date.now() - nodeStartedAt,
            costPoints: spentPoints,
            costBeans: spentBeans,
          },
        })

        // Log LLM usage（尊重节点实际选的模型）
        if (node.type === 'llm-chat' && output.tokens) {
          const model = await findModel('TEXT', node.inputs?.model ? String(node.inputs.model) : undefined)
          if (model) {
            await prisma.apiUsageLog.create({
              data: {
                userId: user.id,
                modelId: model.id,
                tokensUsed: Number(output.tokens) || 0,
                // 用节点实际记账金额（含折扣/免费额度），而不是模型标价
                pointsDeducted: spentPoints,
                beansDeducted: spentBeans,
                statusCode: 200,
                durationMs: Date.now() - nodeStartedAt,
                source: workflowName ? 'workflow' : 'canvas',
                nodeLabel: node.label,
                requestJson: toDetailJson(pickRequestDetail(inputs)),
                responseJson: toDetailJson(pickResponseDetail(output)),
                runId: canvasRun.id,
                outputKind: outputKindFromModelType(model.type),
              },
            })
          }
        }

        // 生成类节点的使用日志（模型状态监测的数据源）：
        // 之前只有 llm-chat 写了 ApiUsageLog，所以生图/视频模型在面板里永远是「无数据」。
        if (node.type === 'image-generate' || node.type === 'nine-grid-loop' || node.type === 'video-generate' || node.type === 'audio-generate') {
          const logType: ModelType = node.type === 'video-generate' ? 'VIDEO' : (node.type === 'image-generate' || node.type === 'nine-grid-loop') ? 'IMAGE' : 'AUDIO'
          const logModel = await findModel(logType, node.inputs?.model ? String(node.inputs.model) : undefined)
          if (logModel) {
            await prisma.apiUsageLog.create({
              data: {
                userId: user.id,
                modelId: logModel.id,
                tokensUsed: 0,
                pointsDeducted: spentPoints,
                beansDeducted: spentBeans,
                statusCode: 200,
                durationMs: Date.now() - nodeStartedAt,
                source: workflowName ? 'workflow' : 'canvas',
                nodeLabel: node.label,
                requestJson: toDetailJson(pickRequestDetail(inputs)),
                responseJson: toDetailJson(pickResponseDetail(output)),
                runId: canvasRun.id,
                outputKind: outputKindFromModelType(logModel.type),
              },
            }).catch(() => { /* 日志失败不影响主流程 */ })
          }
        }

        // Log image generation usage（尊重节点实际选的模型）
        if ((node.type === 'image-generate' || node.type === 'nine-grid-loop') && output.imageUrl) {
          const imageModel = await findModel('IMAGE', node.inputs?.model ? String(node.inputs.model) : undefined)
          if (imageModel) {
            await prisma.imageGenerationRecord.create({
              data: {
                userId: user.id,
                modelId: imageModel.id,
                prompt: imagePromptForLog(node, inputs),
                negativePrompt: String(
                  inputs.negativePrompt || node.inputs.negativePrompt || ''
                ) || null,
                width: Number(inputs.width ?? node.inputs.width ?? 1024),
                height: Number(inputs.height ?? node.inputs.height ?? 1024),
                imageUrl: String(output.imageUrl),
                costPoints: imageModel.costPoints,
                status: 'SUCCESS',
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                runId: canvasRun.id,
              },
            })
          }
        }

        // 批量节点执行成功 → 后端就地展开副本：主本(index 0) + 副本(1..N-1) 一次跑完、同一套语块
        if (node.type === 'json-prompt-batch') {
          const prompts = Array.isArray(output.prompts) ? (output.prompts as unknown[]) : []
          // outputMode 决定「谁来做扇出」：
          //   'expand'（默认，向后兼容）— 后端就地克隆下游节点 N 份，第 i 份取第 i 套语块；
          //   'index'                    — 下游是作者**静态排布**好的 N 个节点，各自用连线 index 取第 i 套，
          //                                这里不能再克隆，否则会多跑 N-1 份 → 重复扣费、重复出图。
          // 必须是显式开关而非启发式：画布首次展开会把主连线写成 index:0，
          // 一旦用「有 index 就不展开」来猜，二次运行会静默少跑。
          const batchMode = String(node.inputs?.outputMode ?? 'expand')
          if (prompts.length >= 2 && batchMode !== 'index') {
            const expansion = expandBatchCopies(node, prompts.length, nodes, connections)
            if (expansion) {
              // 主本连线设 index 0（取第 1 套语块）
              const mainConn = connections.find((c) => c.id === expansion.mainConnId)
              if (mainConn) mainConn.index = 0
              // 追加预扣副本成本（副本里 llm/image/video 模型按节点实际选的模型计价；预算池随之扩充）
              const copyCharge = await (async () => {
                let cost = 0
                let beans = 0
                for (const c of expansion.copies) {
                  const cModelId = c.inputs?.model ? String(c.inputs.model) : undefined
                  const cMeta = nodeModelMap.get(
                    c.id,
                  ) // 副本默认继承主本模型，若副本单独指定模型则重新查
                  let chargeModel = cMeta
                  if (!chargeModel || cModelId) {
                    // 副本也可能是 video-generate：此前这里只映射 image/text，
                    // 视频副本落到 'TEXT' 分支 → 查 TEXT 模型 → 按积分计费，
                    // 于是「批量展开视频」既没预扣豆、又没按豆记账，直接白嫖。
                    const type: ModelType =
                      c.type === 'video-generate' ? 'VIDEO' : (c.type === 'image-generate' || c.type === 'nine-grid-loop') ? 'IMAGE' : 'TEXT'
                    const m = cModelId
                      ? await prisma.modelConfig.findFirst({ where: { id: cModelId, isActive: true } })
                      : null
                    if (m) {
                      chargeModel = {
                        id: m.id,
                        type,
                        costPoints: m.costPoints,
                        videoCost: m.videoCost,
                        discount: m.discount,
                        isFree: m.isFree,
                        dailyUserFreeQuota: m.dailyUserFreeQuota,
                        metadata: (m.metadata as Record<string, unknown> | null) ?? null,
                      }
                    }
                  }
                  if (!chargeModel) continue
                  if ((await checkFreeImagePass({ id: chargeModel.id, type: chargeModel.type, dailyUserFreeQuota: chargeModel.dailyUserFreeQuota }, user, user.id)).free) continue
                  // 与顶层预扣同一口径：副本的计费因子也必须经 nodeChargeInputs，
                  // 否则批量展开的视频副本会漏掉 resolution / duration 而算成 0 或低价。
                  const charge = planNodeCharge(chargeModel.type, chargeModel, nodeChargeInputs(c.inputs))
                  cost += charge.points
                  beans += charge.beans
                }
                return { cost, beans }
              })()
              const copyCost = copyCharge.cost
              const copyCostBeans = copyCharge.beans
              if (copyCost > 0 || copyCostBeans > 0) {
                try {
                  // 副本预扣两币种同一事务（Q-D04）：以前先扣豆再扣积分、豆失败手工回滚积分，
                  // 且积分预检读 user.points（团队场景钱在出资人账上，成员恒被误拒）——
                  // deductRunCharge 内部是条件原子扣减，归属解析与顶层预扣同口径。
                  await walletDeductRunCharge({ userId: user.id, points: copyCost, beans: copyCostBeans, description: '画布批量展开副本预扣', runId: canvasRun.id })
                } catch (err) {
                  const message = err instanceof Error ? err.message : '批量展开副本余额不足'
                  throw new RunGraphError(/积分不足/.test(message) ? 'INSUFFICIENT_POINTS' : 'INSUFFICIENT_BEANS', message, 402)
                }
                budgetPoints += copyCost
                budgetBeans += copyCostBeans
                // 追加预扣并入 hold，保证崩溃对账覆盖批量副本金额
                if (holdId) {
                  if (copyCost > 0) {
                    await prisma.billingHold.update({
                      where: { id: holdId },
                      data: { points: { increment: roundPoints(copyCost) } },
                    }).catch((e) => console.error('批量副本并入 hold 失败:', e))
                  }
                  if (copyCostBeans > 0) {
                    await prisma.billingHold.update({
                      where: { id: holdId },
                      data: { beans: { increment: roundPoints(copyCostBeans) } },
                    }).catch((e) => console.error('批量副本并入 hold（豆）失败:', e))
                  }
                }
              }
              // 副本入队立即执行（增量执行时把副本加入执行集，避免被跳过）
              expansion.copies.forEach((c) => executeIdSet?.add(c.id))
              queue.unshift(...expansion.copies)
              connections.push(...expansion.conns)
              await emit({ type: 'batchExpanded', copies: expansion.copies, conns: expansion.conns, mainConnId: expansion.mainConnId })
            }
          }
        }
      } catch (err: unknown) {
        // 节点失败是所有上游异常汇聚到数据库的唯一入口（api_usage_logs.errorMessage）。
        // 网络层失败（undici）原本只留下 "fetch failed" 这种无法定位的文案，
        // 这里统一翻译成中文 + 机器码（如「网络连接中断，请重试 (ECONNRESET)」）。
        const error = toUpstreamError(err).message || '节点执行失败'
        // 失败也写一条使用日志（statusCode=500）：否则「模型状态监测」只统计成功调用，
        // 失败率永远是 100%，看不出哪个模型在挂。
        if (node.type === 'image-generate' || node.type === 'nine-grid-loop' || node.type === 'video-generate' || node.type === 'audio-generate' || node.type === 'llm-chat') {
          const logType: ModelType = node.type === 'video-generate' ? 'VIDEO' : (node.type === 'image-generate' || node.type === 'nine-grid-loop') ? 'IMAGE' : node.type === 'audio-generate' ? 'AUDIO' : 'TEXT'
          const logModel = await findModel(logType, node.inputs?.model ? String(node.inputs.model) : undefined).catch(() => null)
          if (logModel) {
            await prisma.apiUsageLog.create({
              data: {
                userId: user.id,
                modelId: logModel.id,
                tokensUsed: 0,
                pointsDeducted: 0,
                statusCode: 500,
                errorMessage: error.slice(0, 300),
                durationMs: Date.now() - nodeStartedAt,
                source: workflowName ? 'workflow' : 'canvas',
                nodeLabel: node.label,
                // 失败时请求详情尤其重要：能直接看出是提示词问题还是上游问题
                requestJson: toDetailJson(pickRequestDetail(inputs)),
                responseJson: toDetailJson({ error }),
                runId: canvasRun.id,
                outputKind: outputKindFromModelType(logModel.type),
              },
            }).catch(() => { /* 忽略 */ })
          }
        }
        // 节点失败：回滚本节点已占用的每日免费额度，避免用户白损失一次
        if (nodePendingFreeQuotaModels.size > 0) {
          for (const modelId of nodePendingFreeQuotaModels) {
            await releaseFreeQuota(modelId, user.id)
          }
          nodePendingFreeQuotaModels = new Set<string>()
        }
        // 节点失败：归还本节点占用的时长券名额（删除台账行）
        if (nodePendingPassUsageIds.size > 0) {
          for (const usageId of nodePendingPassUsageIds) {
            await releaseFreeImagePass(usageId)
          }
          nodePendingPassUsageIds = new Set<string>()
        }
        await emit({ type: 'nodeError', nodeId: node.id, error })
        throw err
      }
    }

    await emit({ type: 'done', outputs, runId: canvasRun.id })
    // P6: 记录完成状态 + 输出快照；成本记实际消耗（预扣超出部分已在下方退回）
    if (canvasRun) {
      await prisma.canvasRun.update({
        where: { id: canvasRun.id },
        data: { status: 'SUCCEEDED', seedOutputs: toJson(outputs), costPoints: consumedPoints, costBeans: consumedBeans },
      }).catch((e) => console.error('画布完成状态更新失败:', e))
    }
    // 成功也退差额：预扣是估算（可能按兜底模型高估），高估部分退回。
    // ⚠️ 低估（consumed > budget）不能「多退少不补」地静默放过 —— 预扣低于实扣时
    // 若不补扣，用户就白嫖了那部分（2026-10-15 事故：漏传 resolution 导致预扣 0、
    // 实扣 300，300 豆凭空消失，真实扣款流水一条都没有）。这里按差额补扣并留痕。
    // 补扣预扣不足的部分：写 category=null 的真实流水，余额与账本同步收敛。
    // 补扣失败（余额已被同期任务花掉等）只记日志不抛，保证用户仍能拿到产出。
    if (consumedBeans > budgetBeans) {
      const short = roundPoints(consumedBeans - budgetBeans)
      await walletDeductBeans({ userId: user.id, amount: short, description: '画布视频节点补扣预扣差额', runId: canvasRun?.id })
        .catch((e) => console.error('[executor] 补扣豆差额失败（需人工核查）:', e))
    }
    // 成功退差额后结算 hold：该次预扣已对平，避免惰性对账重复退。
    // 退差额 + 置 SETTLED 同一事务（Q-D03），退款失败时 hold 保持 OPEN 交由对账重试。
    await settleBudgetRemainder({ canvasRun, userId: user.id, budgetPoints, consumedPoints, budgetBeans, consumedBeans, label: '完成' })

    return { runId: canvasRun.id, status: 'SUCCEEDED', outputs, costPoints: consumedPoints, costBeans: consumedBeans }
  } catch (err: unknown) {
    // 同样走统一翻译：这一层的 message 会写进 canvas_runs.error，并作为 SSE error 事件发给前端。
    // 不翻译的话用户看到的就是「执行失败：fetch failed」这种无从下手的话。
    const message = toUpstreamError(err).message || '工作流执行失败'
    await emit({ type: 'error', message })

    // P6: 记录失败状态；成本记实际消耗
    if (canvasRun) {
      await prisma.canvasRun.update({
        where: { id: canvasRun.id },
        data: { status: 'FAILED', error: message, costPoints: consumedPoints, costBeans: consumedBeans },
      }).catch((e) => console.error('画布失败状态更新失败:', e))
    }

    // 失败退款：只退未消耗部分（已成功节点消耗的积分/豆不退），含批量展开追加的副本预算。
    // 退款 + 置 SETTLED 同一事务（Q-D03），退款失败时 hold 保持 OPEN 交由对账重试。
    await settleBudgetRemainder({ canvasRun, userId: user.id, budgetPoints, consumedPoints, budgetBeans, consumedBeans, label: '失败' })

    return { runId: canvasRun.id, status: 'FAILED', outputs: {}, error: message, costPoints: consumedPoints, costBeans: consumedBeans }
  }
}
