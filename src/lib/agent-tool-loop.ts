// Agent 动作层（第 2 期）：有界工具循环执行器
//
// ===== 它替换了什么 =====
// 替换 runAgent 里「一次规划出大 JSON → 批量执行」的路径。新路径：
//   模型 → 一个 tool_call → 我们执行 → 结果喂回 → 模型 → ... → finish
// 最多 MAX_TURNS 轮（用户要求「循环两三次就能完成」）。
//
// ===== 为什么不是照搬通用 harness =====
// 我们业务只需要：出图（含图生图）、缺参就问、多轮接着改。
// 不需要插件内核 / 作用域 / 跨进程 RPC / 多 agent 委托 —— 那些复杂度换不来我们的收益。
//
// ===== 关键复用（不新造轮子） =====
// - 计费 + 免费额度 + 失败退款 + 调用日志：全部走 chargeRun（与工具面板/画布同一条路）
// - 生图/生视频执行：直接复用 runDeliverable（排队、mock、首帧图、参考图解析全都在里面）
// - 前端事件：沿用既有 SSE 事件形状（thinking/subtask/media/content/agentReply）

import { getPrisma } from '@/lib/prisma'
import { HISTORY_MESSAGES, HISTORY_CONTENT_CHARS, historyMessagesBudgetChars, historySummaryBudgetChars } from '@/lib/agent-context-window'
import { streamChatToUpstream } from '@/lib/llm-provider'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { buildModelBrief, formatUserPreferencesText, formatUserMemoryText, resolveAgentReasoningEffort, type AgentDeliverable } from '@/lib/agent-plan'
import { getAgentPreferences } from '@/lib/agent-preferences'
import { getAgentSkills, appendSkillFragments } from '@/lib/agent-skills'
import { publicizeReferenceImages } from './upstream-image'
import { mediaLabel } from '@/lib/media-kinds'
import { loadSessionAssetPool, describePool, type SessionAssetPool } from './agent-asset-pool'
import {
  AGENT_TOOL_SPECS,
  TOOL,
  buildAgentToolSystemPrompt,
  pickActions,
  asString,
  asStringArray,
  asPositiveInt,
} from '@/lib/agent-tools'
import { toPendingAction, queuedToolText, shouldGateActions, type PendingAction } from '@/lib/agent-pending'
import { assertAgentTaskActive } from '@/lib/agent-cancel'
import { AGENT_MAX_PLANNER_TURNS, AGENT_MAX_TOOL_ACTIONS } from '@/lib/agent-budget'
import {
  AGENT_CHECKPOINT_VERSION,
  isAgentCheckpointExpired,
  parseAgentCheckpoint,
  sanitizeCheckpoint,
  type AgentCheckpoint,
} from '@/lib/agent-checkpoint'
import type { AdapterToolCall } from '@/types'

/**
 * 循环上限。超出即强制收尾，避免模型无限「再问一句」。
 *
 * 4 → 6（2026-10-04，随上下文放宽）：实测「派发 5~6 张 → 其中几张失败要换模型重试
 * → 再补一张」这种返工场景，4 轮会在收尾前就用完（第 4 轮被迫 finish，
 * 剩下没派完的只能丢掉）。用户原话「循环两三次就能完成」指的是**顺利路径**，
 * 返工路径需要额外余量。6 轮仍是有界的，不会变成无限循环。
 */
export const MAX_TURNS = AGENT_MAX_PLANNER_TURNS

// 窗口参数统一收在叶子模块 agent-context-window（不 import 业务代码，避免循环依赖）：
// executor 静态 import 本文件，常量若放这里，executor 再值引用就构成运行时环。
// 这里 re-export 是为了保持既有引用（含测试）零改动。
export {
  HISTORY_MESSAGES,
  HISTORY_CONTENT_CHARS,
  HISTORY_SUMMARY_CHARS,
  HISTORY_SUMMARY_STORE_CHARS,
} from '@/lib/agent-context-window'

/**
 * 首轮即失败、且无任何进展时抛出的「回落信号」：
 * 说明规划模型这一池子都不吃 function calling（上游拒 tools 参数 / 直接 400）。
 * 调用方（runAgent）捕获它后会回落到旧的单次规划路径，保证「换个模型也不会变砖」。
 * 与普通失败区分开，避免真实上游故障时被误当成「不支持工具」而重复跑一遍旧路径。
 */
export class ToolLoopUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolLoopUnsupportedError'
  }
}

/** 工具回合的规划超时（与旧规划同一口径，见 agent-executor 的 PLANNING_TIMEOUT_MS 注释） */
const TURN_TIMEOUT_MS = 720_000

export interface ToolLoopInput {
  emit: (obj: Record<string, unknown>) => void
  userId: string
  taskId: string
  prompt: string
  images?: string[]
  sessionId?: string | null
  skillIds?: string[]
  /** 每个 deliverable 的执行体（复用 runDeliverable，注入以便测试与解耦） */
  runDeliverable: (
    d: AgentDeliverable,
    ctx: ToolLoopCtx,
  ) => Promise<{ result: Record<string, unknown>; cost: number; beans: number }>
  /** 默认档位（全局偏好），deliverable 未指定时使用 */
  defaultTier?: string | null
  /** 默认图片/视频模型（全局偏好），模型省略时真正进入执行链 */
  defaultImageModelId?: string | null
  defaultVideoModelId?: string | null
  /** 本轮请求参数（与工具面板口径一致），透传给 runDeliverable */
  params?: Record<string, unknown>
  /** 执行权限：confirm 时执行类动作先入待确认队列，不真跑 */
  executeMode?: string | null
  /** confirm 模式的待确认队列（调用方持有，任务结束后落库） */
  pendingActions?: PendingAction[]
  /** 修订上下文：用户对上一版方案的修改意见（重新规划时注入） */
  revision?: import('@/lib/agent-executor').AgentRevision | null
  /** 规划模型候选（已按优先级排序，含 provider.apiKey） */
  candidates: { id: string; name: string; modelName: string; type: string; supportsVision?: boolean | null; metadata?: unknown; /** 模型声明的上下文窗口；用于按模型能力算历史预算 */ contextWindow?: number | null; provider: { baseUrl: string; apiKey: string | null; adapterId?: string | null; configJson?: unknown } }[]
  /** 已持久化的检查点；任务恢复时传入 */
  checkpoint?: AgentCheckpoint | null
  /** 每完成一轮/一个动作后持久化；失败会由调用方决定是否阻断 */
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>
}

/** ask_user 结构化问题：前端据此渲染可点选项 */
export interface AskQuestion {
  question: string
  options: string[]
}

export interface ToolLoopResult {
  subtasks: Record<string, unknown>[]
  totalCost: number
  totalBeans: number
  reply: string
  decisions: { label: string; value: string; reason: string }[]
  /** ask_user 的结构化问题：让前端渲染成可点选项，而不是让用户照着文字手打 */
  askQuestions?: AskQuestion[]
  /** 是否走到 finish（false 表示轮次耗尽被强制收尾） */
  finished: boolean
  /** 实际用掉的轮次 */
  turns: number
  /** confirm 模式收集到的待确认执行项（auto 模式恒为空） */
  pendingActions?: PendingAction[]
  /** 轻量执行轨迹：不替代调用日志，只把一次 Agent run 的轮次/动作串起来 */
  agentTrace?: AgentTraceEntry[]
  /** 最新检查点，供路由最终落库 */
  checkpoint?: AgentCheckpoint
}

export type AgentTraceEntry = {
  turn: number
  action: string
  modelId?: string
  status: 'success' | 'failed' | 'blocked' | 'cancelled'
  durationMs: number
  cost?: number
  beans?: number
  detail?: string
}

/**
 * 循环执行上下文。
 *
 * 刻意**结构化声明**而不从 agent-executor 导入 AgentRunCtx：agent-executor 会动态
 * import 本模块，若这里再反向 import 它的类型，就会构成循环引用，生产构建下触发
 * TDZ（Cannot access 'H' before initialization）。字段与 AgentRunCtx 保持一致，
 * 结构类型兼容，调用处可直接传入 AgentRunCtx。
 */
export type ToolLoopCtx = {
  emit: (obj: Record<string, unknown>) => void
  userId: string
  taskId: string
  prompt: string
  images?: string[]
  sessionId?: string | null
  params?: Record<string, unknown>
  defaultTier?: string | null
  /** 可用模型能力清单，供 list_models 回填 */
  modelRows?: ModelBriefRow[]
  /** 会话素材池的「编号 → URL」解析表（assetIds 写「素材2」「图片1」时靠它） */
  poolByAlias?: Map<string, string>
  /**
   * 执行权限（auto / confirm）。confirm 时执行类动作不真跑，
   * 改为往 pendingActions 里记一条待确认项。
   */
  executeMode?: string | null
  /** confirm 模式的待确认队列（由调用方注入并在任务结束后落库） */
  pendingActions?: PendingAction[]
  /** 修订上下文（首轮注入一次） */
  revision?: import('@/lib/agent-executor').AgentRevision | null
  /** 本轮新产物的下一个「素材N」序号（并发注册时由单线程事件循环串行递增） */
  nextGeneratedAssetIndex?: number
  /** 全局偏好中的默认模型；模型参数省略时使用 */
  defaultImageModelId?: string | null
  defaultVideoModelId?: string | null
}

/** buildModelBrief 的行形状（供 list_models 回填精简清单） */
type ModelBriefRow = {
  id: string
  name: string
  capability: string
  free?: boolean
  ratios?: string
  tiers?: string
  /** 合法图片规格组合（ratio@tier），用于阻止“比例存在、档位存在、组合不存在”的非法参数 */
  sizePairs?: string
  ref?: string
  /** 视频清晰度档（仅 VIDEO；与 planner 菜单同一来源） */
  resolutions?: string
  /** 视频可选时长（仅 VIDEO） */
  durations?: string
}

/** 工具返回值：统一成模型看得懂的短文本 + 结构化数据 */
type ToolOutcome = {
  /** 回填给模型的文本 */
  text: string
  /** 是否结束循环 */
  done?: boolean
  /** 本轮产生的 subtask（用于最终汇总） */
  subtask?: Record<string, unknown>
  cost?: number
  beans?: number
  reply?: string
  decisions?: { label: string; value: string; reason: string }[]
  /** ask_user 专用：结构化问题原样上抛 */
  askQuestions?: AskQuestion[]
}

/** 生成一张图需要的参数（从工具调用参数里提取） */
function toImageDeliverable(
  args: Record<string, unknown>,
  index: number,
  defaultTier?: string | null,
  defaultModelId?: string | null,
): AgentDeliverable {
  const ratio = asString(args.ratio)
  const tier = asString(args.tier) || defaultTier || undefined
  return {
    id: `task-${index}`,
    title: asString(args.title) || '图片',
    type: 'image',
    model: asString(args.model) || defaultModelId || undefined,
    prompt: asString(args.prompt) || '',
    count: asPositiveInt(args.count, 1, 8) ?? 1,
    // 尺寸按「比例@档位」组合下发给 runDeliverable（与操作面板同一套解码）
    ratio: ratio && tier ? `${ratio}@${tier}` : ratio,
    assetIds: asStringArray(args.assetIds),
  }
}

function toVideoDeliverable(args: Record<string, unknown>, index: number, defaultModelId?: string | null): AgentDeliverable {
  return {
    id: `task-${index}`,
    title: asString(args.title) || '视频',
    type: 'video',
    model: asString(args.model) || defaultModelId || undefined,
    prompt: asString(args.prompt) || '',
    ratio: asString(args.ratio),
    resolution: asString(args.resolution),
    seconds: asPositiveInt(args.seconds, 1, 600) ?? undefined,
    assetIds: asStringArray(args.assetIds),
  }
}

/**
 * 有界工具循环。
 *
 * 每轮：模型输出一个动作 → 执行 → 把结果回填成 tool 消息 → 下一轮。
 * 任何一轮出现「无动作」或解析失败，都按结束处理（不空转）。
 */
/**
 * 组装「给模型看的历史对话」。
 *
 * 抽成纯函数是为了能直接单测：这段逻辑（倒序取回→正序、截断长度、空消息过滤、
 * 无历史时不产出空对象）以前散在 runAgentToolLoop 里，出问题只能靠联调发现。
 *
 * @param summary 滚动摘要（chatSession.summary）
 * @param recentDesc 按 seq 倒序取回的最近消息（DB 查询就是倒序）
 * @param contextWindowTokens 模型声明的上下文窗口；文字/摘要预算都由它算出
 *   （见 historyBudgetChars / historySummaryBudgetChars）。不传则退回保守值 ——
 *   调用方（旧测试/回落路径）不该因为没传就拿到空历史。
 */
export function buildConversationContext(
  summary: string | null | undefined,
  recentDesc: {
    role: string
    content: string | null
    /** 助手消息的产物（JSON 数组字符串）—— 让模型看得见自己上一轮出了什么图 */
    mediaUrls?: string | null
    mediaType?: string | null
  }[],
  contextWindowTokens?: number | null,
): { summary?: string; recentMessages?: { role: string; content: string; produced?: string }[] } | null {
  // 正文预算 = 总预算 − 摘要（两者之和恒等于总预算，不会各算各的导致超预算）
  const budget = historyMessagesBudgetChars(contextWindowTokens)
  // 组装时**按 token 预算从最近往前装**（而不是"取最近 N 条"）：
  // 每条消息长度差异极大，按条数取会让「一句短指令」和「一大段上下文」同名对待。
  // 从最近往前累加，超预算就停 —— 保证「最近的一定在、更早的尽量在」。
  const ordered = [...recentDesc].reverse()
  const kept: { role: string; content: string; produced?: string }[] = []
  let used = 0
  for (const m of [...ordered].reverse()) {
      const content = String(m.content || '').trim().slice(0, HISTORY_CONTENT_CHARS)
      // 助手的产物：正文是「已生成图片」这类占位文字，不带产物的话
      // 模型看历史时根本不知道上一轮出了什么（改图时会改错张数/张）。
      // 只给数量与类型，不塞 URL —— URL 又长又占 token，真要引用走 assetIds 编号。
      let produced: string | undefined
      if (m.role === 'assistant' && m.mediaUrls) {
        let n = 0
        try {
          const v = JSON.parse(m.mediaUrls)
          if (Array.isArray(v)) n = v.filter((x) => typeof x === 'string' && x).length
        } catch { /* 脏数据按 0 处理 */ }
        if (n > 0) {
          const unit = mediaLabel(m.mediaType)
          const quant = m.mediaType === 'video' || m.mediaType === 'audio' ? '个' : '张'
          produced = `本回合产出 ${n} ${quant}${unit}`
        }
      }
      // 用 trim 后的空判：纯空白/换行内容会让模型看到一串空行，不如不给
      if (content.length === 0) continue
      const cost = content.length + (produced ? produced.length : 0)
      // 至少保留最近一条：即使单条就超预算，也不能让历史变成空
      if (kept.length > 0 && used + cost > budget) break
      kept.push({ role: m.role, content, ...(produced ? { produced } : {}) })
      used += cost
  }
  const recentMessages = kept.reverse() // 回到时间正序
  const s = (summary || '').trim()
  if (!s && recentMessages.length === 0) return null
  return {
    // 摘要也按同一套预算（窗口越大能回忆的越早，不再固定 3000 字）
    ...(s ? { summary: s.slice(-historySummaryBudgetChars(contextWindowTokens)) } : {}),
    ...(recentMessages.length > 0 ? { recentMessages } : {}),
  }
}

export async function runAgentToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { emit, userId, taskId, prompt, images, skillIds, candidates, defaultTier } = input
  /** confirm 模式的待确认队列：调用方传入则直接往里收，任务结束后由它落库 */
  const pendingActionsRef = input.pendingActions
  const restored = input.checkpoint
    ? parseAgentCheckpoint(input.checkpoint, { taskId, userId })
    : null
  const checkpoint = restored && !isAgentCheckpointExpired(restored) ? restored : null
  if (input.checkpoint && !checkpoint) {
    throw new Error('Agent 检查点无效或已过期，请重新发起任务')
  }

  const prisma = await getPrisma()
  const activeSkills = getAgentSkills(skillIds)
  const systemPrompt = appendSkillFragments(buildAgentToolSystemPrompt(), activeSkills)

  // 参考图公网化：与旧路径同一函数，保证「上传图 → 上游可访问 URL」行为一致
  const publicImages = await publicizeReferenceImages(images, userId)
  const referencedAssets = publicImages.map((url, i) => ({ alias: `图片${i + 1}`, url }))

  // 会话素材池：本会话已上传/已生成的图（chat_messages 里本就有，此前没人读）。
  // 模型靠它理解「第 3 张」「刚才那张」这类指代，并在跨轮时复用参考图。
  const assetPool: SessionAssetPool = await loadSessionAssetPool(input.sessionId)
  const poolText = describePool(assetPool)
  // 编号 → URL 的解析表：assetIds 里写「图片1」「素材2」都能查到真实地址。
  //
  // ⚠️ 必须公网化：池子里的 URL 直接来自 chat_messages，用户上传图存的是
  // `/api/asset/...` **站内相对路径**（实测生产库 51 条是这样的，9 条是上游外链）。
  // 不转换就交给上游 = 上游收到相对路径，根本拉不到图，跨轮引用静默失败。
  // 与 ctx.images 走同一函数（publicizeReferenceImages），口径一致。
  // 失效的站内素材会抛错 → 这里逐条兜底，坏的那条跳过而不是整轮失败。
  const poolByAlias = new Map<string, string>()
  for (const a2 of [...assetPool.uploaded, ...assetPool.generated]) {
    try {
      const [pub] = await publicizeReferenceImages([a2.url], userId)
      poolByAlias.set(a2.alias, pub || a2.url)
    } catch {
      // 站内素材已被清理（TTL 到期）→ 不放进表，模型引用时会解析不到、退回本轮上传图
    }
  }
  // 当前轮上传图覆盖同名旧编号：用户这一轮刚上传的「图片1」应优先于历史会话里的图片1。
  for (const [i, url] of publicImages.entries()) poolByAlias.set(`图片${i + 1}`, url)
  // 恢复时把本 run 已生成、但尚未写进 chat_messages 的素材编号补回。
  for (const [alias, url] of Object.entries(checkpoint?.assetAliases || {})) {
    poolByAlias.set(alias, url)
  }
  const maxGeneratedIndex = [...poolByAlias.keys()].reduce((max, key) => {
    const m = /^素材(\d+)$/.exec(key)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0)

  // 会话历史：模型必须看得到之前聊过什么，才能理解「再来一张」「换成 4:3」「刚才那两张」。
  //
  // ⚠️ 这是一个真实缺口的修补：工具循环上线时，下面注释写着「模型看得到历史对话」，
  // 但 messages 实际从空数组开始、只塞了当轮 content —— 旧单次规划路径有
  // conversationContext（摘要 + 最近 6 条），换成工具循环后丢了。
  // 症状：用户说「生成两张海报图对比风格」，Agent 反问「海报主题是什么」——
  // 因为它根本不记得上一轮说过的内容。
  //
  // 历史窗口：rollingSummary + 最近 HISTORY_MESSAGES 条。
  //
  // 为什么从 6 条提到 12 条：6 条 ≈ 3 个来回，用户做多轮改图（「第 3 张重做」
  // →「再换 4:3」→「背景再亮一点」）时，第 4 个来回就把最早那轮挤掉了，
  // 表现为「它忘了第一轮定的基调」。12 条 ≈ 6 个来回，覆盖一次完整的改图对话。
  //
  // ⚠️ 同时 select mediaUrls/mediaType：助手消息的正文是「已生成图片」这种占位文字，
  // 不带媒体信息的话，模型看历史时**看不到自己上一轮产出了什么**，
  // 只能靠会话素材池兜（那是另一套数据，且只给编号不给关联轮次）。
  const [sessionRow, recentMsgs] = input.sessionId
    ? await Promise.all([
        prisma.chatSession.findUnique({ where: { id: input.sessionId }, select: { summary: true } }),
        prisma.chatMessage.findMany({
          where: { sessionId: input.sessionId, status: 'DONE' },
          orderBy: { seq: 'desc' },
          take: HISTORY_MESSAGES,
          select: { role: true, content: true, mediaUrls: true, mediaType: true },
        }),
      ])
    : [null, [] as { role: string; content: string; mediaUrls: string | null; mediaType: string | null }[]]
  // 历史窗口按**模型声明的上下文窗口**算（不再写死条数）：
  // 配 248K 就该看到 248K 的历史，而不是被固定的条数卡住。
  //
  // ⚠️ 取候选里**最小**的窗口，不是最大：
  // 候选是一条降级链，实际用哪个要试过才知道。若按最大的（如 GLM-5.3-Flash 1M）
  // 装 80 万字符历史，主模型失败降级到 248K 的模型时**直接超窗口被上游 400**。
  // 取最小则「在链上哪个模型上都装得下」，降级安全。
  const minContextWindow = candidates.reduce<number | undefined>(
    (mn, c) => (c.contextWindow && c.contextWindow < (mn ?? Infinity) ? c.contextWindow : mn),
    undefined,
  )
  const conversationContext = buildConversationContext(
    sessionRow?.summary,
    recentMsgs,
    minContextWindow,
  )

  const userPrefs = await getAgentPreferences(userId)

  // 可用模型能力清单：模型靠它决策选哪个模型/比例/档位，不靠记忆。
  //
  // ⚠️ 必须在 nameOf/prefsText **之前**取好：nameOf 闭包引用 modelRows，
  // 而 formatUserPreferencesText 会立即调用 nameOf。若把 modelRows 声明放在后面，
  // 就构成 const 的 TDZ（Cannot access 'modelRows'/'H' before initialization）
  // —— 生产压缩产物里变量名变成 H，错误信息即「Cannot access 'H' before initialization」。
  const modelRows = await prisma.modelConfig.findMany({
    where: { isActive: true, provider: { isActive: true } },
    select: { id: true, name: true, type: true, costPoints: true, isFree: true, metadata: true },
  })
  const modelBrief = buildModelBrief(modelRows)

  // 偏好串人话化：把裸 cuid 换成模型可读的名字（与旧路径同一函数，口径一致）
  const nameOf = (id: string | null | undefined): string | null => {
    if (!id) return null
    const hit = modelRows.find((m) => m.id === id)
    return hit ? hit.name : null
  }
  const prefsText = formatUserPreferencesText(userPrefs, nameOf)
  // 用户自述（长期记忆）：纯手填，全局生效。与偏好分两段注入 ——
  // 偏好是「用什么工具」，记忆是「他是谁」，模型会把两类事实分开用。
  const memoryText = formatUserMemoryText(userPrefs.memoryText)

  const subtasks: Record<string, unknown>[] = checkpoint ? [...checkpoint.subtasks] : []
  let totalCost = checkpoint?.totalCost || 0
  let totalBeans = checkpoint?.totalBeans || 0
  let deliverableIndex = checkpoint?.deliverableIndex || 0
  let lastText = checkpoint?.lastText || ''
  let askQuestions: AskQuestion[] | undefined = checkpoint?.askQuestions
  let decisions: { label: string; value: string; reason: string }[] = checkpoint?.decisions || []
  let finished = checkpoint?.finished || false
  let actualTurns = checkpoint?.turn || 0
  let actionCount = checkpoint?.actionCount || 0
  let nextGeneratedAssetIndex = checkpoint?.nextGeneratedAssetIndex || maxGeneratedIndex + 1
  const agentTrace: AgentTraceEntry[] = checkpoint?.agentTrace ? [...checkpoint.agentTrace] : []
  const checkpointCreatedAt = checkpoint?.createdAt || new Date().toISOString()

  // 会话：模型看得到历史对话，才能理解「再来一张」「换成 4:3」这类指代
  const messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }[] =
    checkpoint?.messages ? [...checkpoint.messages] : []

  // 首轮 = 结构化上下文（偏好/参考图/可用模型能力），与旧 plannerInput 等价的精简版
  const contextPayload = {
    requirement: prompt,
    userPreferencesText: prefsText,
    // 用户自述：让 Agent 不必反复问「你是做什么的/喜欢什么风格」
    ...(memoryText ? { userMemoryText: memoryText } : {}),
    // 历史对话：让「再来一张」「换成 4:3」这类指代有据可依
    ...(conversationContext ? { conversationContext } : {}),
    referencedAssets,
    // 本会话已有素材（编号清单）——跨轮指代靠它，如「素材3 重做」「沿用图片1」
    ...(poolText ? { sessionAssets: poolText } : {}),
    availableModels: modelBrief,
    // 修订：把「上一版方案 + 用户意见」交给模型重排。
    // 写成结构化字段而不是拼进 requirement，是为了让模型清楚区分
    // 「原始需求」和「这一版要改什么」，否则它容易把上一版的细节当成新需求重复一遍。
    ...(input.revision
      ? {
          revision: {
            round: input.revision.round,
            instruction: input.revision.note,
            note: '这是用户对上一版方案的修改意见。请保留上一版中用户没有要求改动的部分，只调整他指出的地方，重新给出完整方案。',
            previousPlan: input.revision.previous.map((p) => ({
              title: p.title,
              type: p.kind,
              prompt: p.prompt,
              count: p.count,
              ...(p.ratio ? { ratio: p.ratio } : {}),
              ...(p.quality ? { quality: p.quality } : {}),
              ...(p.resolution ? { resolution: p.resolution } : {}),
              ...(p.seconds != null ? { seconds: p.seconds } : {}),
            })),
          },
        }
      : {}),
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: JSON.stringify(contextPayload) })
  }

  if (pendingActionsRef && checkpoint?.pendingActions?.length) {
    pendingActionsRef.push(...checkpoint.pendingActions)
  }

  // 写入前统一封顶（Q-D16）：消息尾部条数、单条正文长度、trace 条数
  // 都由 agent-checkpoint 的同一组常量控制，避免长任务 payload 无界膨胀。
  const makeCheckpoint = (completedTurns: number, done = finished): AgentCheckpoint => sanitizeCheckpoint({
    version: AGENT_CHECKPOINT_VERSION,
    taskId,
    userId,
    createdAt: checkpointCreatedAt,
    updatedAt: new Date().toISOString(),
    turn: completedTurns,
    actionCount,
    messages: messages.map((m) => ({ ...m })),
    deliverableIndex,
    subtasks: [...subtasks],
    totalCost,
    totalBeans,
    lastText,
    decisions: [...decisions],
    ...(askQuestions?.length ? { askQuestions: [...askQuestions] } : {}),
    ...(pendingActionsRef?.length ? { pendingActions: [...pendingActionsRef] } : {}),
    assetAliases: Object.fromEntries(
      [...poolByAlias.entries()].filter(([alias]) => /^素材\d+$/.test(alias)),
    ),
    nextGeneratedAssetIndex,
    agentTrace: [...agentTrace],
    finished: done,
  })

  let checkpointPersistFailed = false

  const persistCheckpoint = async (completedTurns: number, done = finished) => {
    const next = makeCheckpoint(completedTurns, done)
    try {
      await input.onCheckpoint?.(next)
    } catch (err) {
      // 检查点落库失败：**记下并在下一轮动作派发前中止**（Q-D13）。
      // 以前只 warn 继续跑 —— 检查点落后于实际执行进度，失败后 resume 会从更早的
      // 检查点重放已执行、已扣费的动作（二次扣费）。立即中止可保证
      // 「已执行动作 = 已入检查点动作」，resume 只重放当前轮（其动作尚未派发）。
      // 任务会转 FAILED，用户可从最后一个有效检查点恢复。
      checkpointPersistFailed = true
      console.error('[agent] checkpoint 持久化失败（下一轮动作派发前中止，防恢复重放重复扣费）:', err)
    }
    return next
  }

  if (finished) {
    return {
      subtasks,
      totalCost,
      totalBeans,
      reply: lastText,
      decisions,
      askQuestions,
      finished,
      turns: actualTurns,
      pendingActions: pendingActionsRef && pendingActionsRef.length > 0 ? pendingActionsRef : undefined,
      agentTrace,
      checkpoint: makeCheckpoint(actualTurns, true),
    }
  }

  const startTurn = Math.max(0, checkpoint?.turn || 0)
  for (let turn = startTurn; turn < MAX_TURNS; turn++) {
    await assertAgentTaskActive(taskId)
    actualTurns = turn + 1
    const turnStartedAt = Date.now()
    // ===== 选一个能用的规划模型（带降级） =====
    let outcome: { actions: ReturnType<typeof pickActions>; raw: string; brainId: string } | null = null
    let lastErr: unknown = null
    const failures: string[] = []
    // 本轮是否有候选明确「吃 tools」（吐了 tool_call）。用于区分：
    //   - 有候选支持 → 当前这个不支持只是它自己的问题，继续试下一个（别回落）
    //   - 全员都不支持 → 才整体回落旧单次规划
    let sawToolCapable = false

    for (const brain of candidates) {
      if (!brain.provider?.apiKey) continue
      let run
      try {
        run = await chargeRun({
          userId,
          modelType: brain.type === 'VISION' ? 'VISION' : 'TEXT',
          modelId: brain.id,
          source: 'agent',
          runId: taskId,
        })
      } catch (err) {
        if (err instanceof ChargeRunError) throw new Error(err.message)
        throw err
      }

      let raw = ''
      let reasoningLen = 0
      try {
        const res = await run.execute(() =>
          streamChatToUpstream(
            brain.provider.baseUrl,
            brain.provider.apiKey as string,
            brain.modelName || brain.name,
            {
              systemPrompt,
              messages,
              temperature: 0.3,
              // 输出预算：思考模型的 reasoning 与正文共用它，而实测推理量在
              // 1272~4700+ token 之间波动（3 倍）。4096 卡在波动下沿 → 复杂场景推理
              // 吃满预算、tool_call 零产出（生产日志「只输出推理过程（14256 字）」即此）。
              // 提到 8192 兜住波动；同时用 reasoningEffort 把推理量压下来（见下）。
              maxTokens: 8192,
              // 思考强度：对「按约束产出动作」这类任务，low 让推理 token 从 ~1272 降到 ~19，
              // 耗时 40s→17s，产出的 tool_call 完全一致。非思考模型不下发该字段。
              reasoningEffort: resolveAgentReasoningEffort(brain.metadata),
              // 模型级图片传输开关（metadata.imageTransport）：只对「拉不动我们图」的
              // 那个模型内联 base64，不影响同一供应商下其它模型。见 llm-provider 注释。
              modelMetadata: (brain.metadata as Record<string, unknown> | null) ?? null,
              supportsVision: Boolean(brain.supportsVision) || brain.type === 'VISION',
              images: publicImages.length > 0 ? publicImages : undefined,
              tools: AGENT_TOOL_SPECS,
              toolChoice: 'auto',
            },
            (t) => {
              raw += t
              if (t.trim()) emit({ type: 'thinking', delta: t })
            },
            (r) => {
              reasoningLen += r.length
              emit({ type: 'thinking', delta: r })
            },
            { adapterId: brain.provider.adapterId, configJson: brain.provider.configJson as Record<string, unknown> | null },
            TURN_TIMEOUT_MS,
            userId,
          ),
        )
        totalCost += run.cost.points

        const actions = pickActions(res.toolCalls)
        if (actions.length > 0) sawToolCapable = true
        if (actions.length === 0) {
          // 没有工具调用 ≠ 故障：模型可能选择直接用文字回答（闲聊场景）。
          // 但如果一个字都没吐，那才是真故障（上游空响应/跑飞），需要降级重试。
          if (!res.content.trim() && !res.toolCalls?.length) {
            // 区分「真故障」与「预算被推理吃满」——
            // 二者在旧报错里都是同一句「模型未产出任何内容」，把排查方向带偏：
            //   finish_reason=length → 上游按我们的 maxTokens 截断了输出，
            //     思考模型的 reasoning 与正文共用预算，推理占满就没轮到 tool_call
            //   finish_reason=stop   → 模型确实只想说话（但它连文字都没有，属实异常）
            const truncated = res.finishReason === 'length'
            throw new Error(
              truncated
                ? `输出被 max_tokens 截断：模型推理了 ${reasoningLen} 字（推理与正文共用输出预算），` +
                  '导致 tool_call 未产出。请提高该模型的输出预算或降低思考强度。'
                : reasoningLen > 0
                  ? `模型只输出推理过程（${reasoningLen} 字），未产出动作`
                  : '模型未产出任何内容',
            )
          }
          // 注意：这里**先不写 lastText** —— 下面还要判「是否旧式大 JSON」，
          // 若是旧计划则会把整坨 JSON 当回复展示给用户，必须让回落路径接管。
        }
        // 该模型不吐 tool_call、却给旧式大 JSON 计划：判定它不支持工具调用。
        // 不 settle（退款），记为「工具不可用」后继续试下一个候选 ——
        // 只要同轮还有候选能正常吐 tool_call，就走工具路径；全员都不行才整体回落旧规划。
        if (isLegacyPlanTurnNoAction(turn, subtasks.length, res.content)) {
          const legacyErr = new ToolLoopUnsupportedError('规划模型未使用工具调用（返回旧式单次计划）')
          await run.fail(legacyErr, { nodeLabel: `Agent 第${turn + 1}轮`, request: { purpose: 'agent-tool-turn', modelId: brain.id, turn } })
          totalCost -= run.cost.points
          lastErr = legacyErr
          failures.push(`${brain.modelName || brain.name}：不支持工具调用`)
          continue
        }
        await run.settle({
          nodeLabel: `Agent 第${turn + 1}轮`,
          request: { purpose: 'agent-tool-turn', modelId: brain.id, turn, tools: AGENT_TOOL_SPECS.map((t) => t.function.name) },
          usage: res,
          response: { action: actions.map((x) => x.name).join(',') || '(text-reply)', content: res.content.slice(0, 500) },
        })
        if (actions.length === 0) lastText = res.content
        outcome = { actions, raw: res.content, brainId: brain.id }
        break
      } catch (err) {
        // 回落信号必须直达调用方：它是「该模型不吃 tools」的判定，不是普通失败，
        // 不能被内层 catch 吞掉后继续降级到下一个候选（会重复试、拖慢且语义错）。
        if (err instanceof ToolLoopUnsupportedError) throw err
        lastErr = err
        failures.push(`${brain.modelName || brain.name}：${err instanceof Error ? err.message : String(err)}`)
        await run.fail(err, { nodeLabel: `Agent 第${turn + 1}轮`, request: { purpose: 'agent-tool-turn', modelId: brain.id, turn } })
      }
    }

    if (!outcome) {
      const aggregated = failures.length > 1
        ? `全部 ${failures.length} 个规划模型均失败 → ` + failures.join(' | ')
        : (lastErr instanceof Error ? lastErr.message : '智能规划失败，请重试')
      // 首轮零进展 + 全员都不吃 tools（无任何候选吐出 tool_call）→ 判定「这些规划模型
      // 都不支持 function calling」，抛回落信号让 runAgent 改走旧单次规划。
      // 只要有一个候选正常吐了 tool_call，就说明链路可用，此处是真实故障，照常上抛。
      // 窄口径：只有失败信息与工具/function 相关时才判「不支持工具调用」并回落。
      // 上游整体宕机（5xx/超时）属于真实故障，照常上抛 —— 回落旧路径会拿同一批候选再失败一遍，纯浪费等待。
      const toolRelated = failures.some((f) => /tool|function|不支持|unsupported/i.test(f))
      if (turn === 0 && subtasks.length === 0 && !sawToolCapable && toolRelated) {
        throw new ToolLoopUnsupportedError(aggregated)
      }
      throw new Error(aggregated)
    }
    agentTrace.push({
      turn: turn + 1,
      action: 'planner',
      modelId: outcome.brainId,
      status: 'success',
      durationMs: Date.now() - turnStartedAt,
    })

    // 无动作：模型选择纯文字回复 → 收尾
    if (outcome.actions.length === 0) {
      lastText = lastText || outcome.raw
      finished = true
      await persistCheckpoint(turn + 1, true)
      break
    }

    // 模型调用可能持续几十秒；用户在此期间点停止时，不能等模型返回后继续派发。
    await assertAgentTaskActive(taskId)
    // 检查点已落后（上一轮落库失败）：再跑下去 resume 必然重放已扣费动作，立即中止（Q-D13）
    if (checkpointPersistFailed) {
      throw new Error('检查点持久化失败，已中止执行以防恢复时重复扣费；请稍后从断点重试')
    }

    const ctx = {
      emit,
      userId,
      taskId,
      prompt,
      images: publicImages,
      sessionId: input.sessionId,
      params: input.params || {},
      defaultTier: input.defaultTier,
      modelRows: modelBrief,
      poolByAlias,
      // confirm 模式：执行类动作只入队不执行（见 agent-pending.ts 的设计说明）
      executeMode: input.executeMode,
      pendingActions: pendingActionsRef,
      nextGeneratedAssetIndex,
      defaultImageModelId: userPrefs.imageModelId,
      defaultVideoModelId: userPrefs.videoModelId,
    }

    // ===== 执行动作 =====
    //
    // 一轮里可能同时有多个动作：模型一次要出 6 张不同方向的图时，会在**同一轮**
    // 发 6 个 generate_image。这里必须并发派发 —— 逐个 await 会退化成
    // "出一张 → 等完 → 再出一张"，出图变成一张一张挤。
    //
    // 但**终止类动作**（ask_user / finish）只认第一个：它们代表"这一轮到此为止"，
    // 与其后面的动作语义冲突（例如 finish 后面又跟一个 generate_image）。所以：
    //   - 有 ask_user/finish → 只执行它，忽略同轮其余动作
    //   - 否则 → 全部并发派发
    const terminalIdx = outcome.actions.findIndex((a) => a.name === TOOL.askUser || a.name === TOOL.finish)
    let execList = terminalIdx >= 0 ? [outcome.actions[terminalIdx]] : outcome.actions
    const remainingActions = AGENT_MAX_TOOL_ACTIONS - actionCount
    if (remainingActions <= 0) {
      lastText = lastText || `已达到本次执行动作上限（${AGENT_MAX_TOOL_ACTIONS} 个），请继续时可发起新任务`
      await persistCheckpoint(turn, false)
      break
    }
    if (execList.length > remainingActions) {
      execList = execList.slice(0, remainingActions)
    }

    const toolResults = await Promise.all(execList.map(async (act, k) => {
      const startedAt = Date.now()
      const result = await executeAction({
        name: act.name,
        args: act.args,
        // 每个动作分配独立的成果区序号（并发时不能共用 deliverableIndex）
        nextIndex: deliverableIndex + k,
        ctx,
        runDeliverable: input.runDeliverable,
      })
      const status: AgentTraceEntry['status'] =
        result.subtask?.status === 'failed' ? 'failed'
          : result.subtask?.status === 'pending' ? 'blocked'
            : result.done ? 'success'
              : result.subtask?.status === 'success' ? 'success' : 'success'
      agentTrace.push({
        turn: turn + 1,
        action: act.name,
        modelId: asString(act.args.model),
        status,
        durationMs: Date.now() - startedAt,
        ...(result.cost != null ? { cost: result.cost } : {}),
        ...(result.beans != null ? { beans: result.beans } : {}),
        detail: result.subtask?.error ? String(result.subtask.error) : undefined,
      })
      return result
    }))
    // 预算只计实际派发执行的动作（Q-D14）：confirm 闸门登记的 pending（真正花钱在
    // 用户确认之后）与纯校验拦截（无 subtask，如缺 prompt）不消耗 24 动作预算 ——
    // 以前模型连续给坏参数/闸门动作会把预算烧光，正常动作反而进不来。
    actionCount += toolResults.filter((r) => r.subtask != null && r.subtask.status !== 'pending').length

    for (const toolResult of toolResults) {
      if (toolResult.subtask) subtasks.push(toolResult.subtask)
      totalCost += toolResult.cost || 0
      totalBeans += toolResult.beans || 0
      if (toolResult.decisions) decisions = toolResult.decisions
      if (toolResult.reply) lastText = toolResult.reply
      if (toolResult.askQuestions && toolResult.askQuestions.length > 0) askQuestions = toolResult.askQuestions
      // 任何媒体产物都占一个成果区序号（原来漏了 audio，音频任务不递增序号）
      if (toolResult.subtask && toolResult.subtask.type !== 'text') {
        deliverableIndex += 1
      }
    }
    nextGeneratedAssetIndex = ctx.nextGeneratedAssetIndex || nextGeneratedAssetIndex

    // ===== 把结果回填给模型 =====
    // assistant 消息必须带**全部** tool_calls（与下面 tool 结果一一对应），
    // 否则 OpenAI 协议校验会因 tool_call_id 不匹配而 400。
    messages.push({
      role: 'assistant',
      content: outcome.raw || '',
      tool_calls: execList.map((act) => ({ id: act.id, type: 'function', function: { name: act.name, arguments: JSON.stringify(act.args) } })),
    })
    for (let k = 0; k < execList.length; k++) {
      messages.push({ role: 'tool', tool_call_id: execList[k].id, name: execList[k].name, content: toolResults[k].text })
    }

    if (toolResults.some((r) => r.done)) {
      finished = true
      await persistCheckpoint(turn + 1, true)
      break
    }
    await persistCheckpoint(turn + 1, false)
  }

  // 轮次耗尽：强制收尾（不让用户干等）
  if (!finished) {
    lastText = lastText || `已完成 ${subtasks.filter((s) => s.status === 'success').length} 个任务（达到轮次上限）`
    await persistCheckpoint(actualTurns, false)
  }

  return {
    subtasks,
    totalCost,
    totalBeans,
    reply: lastText,
    decisions,
    askQuestions,
    finished,
    turns: actualTurns,
    pendingActions: pendingActionsRef && pendingActionsRef.length > 0 ? pendingActionsRef : undefined,
    agentTrace,
    checkpoint: makeCheckpoint(actualTurns, finished),
  }
}

/**
 * 判断模型正文是不是旧式「一次性大 JSON 计划」。
 * 只认计划协议里独有的字段名，避免把普通含 JSON 的闲聊误判成旧计划。
 */
/** 首轮即体现「不支持工具调用」：无动作、零进展，却在正文里吐了旧式大 JSON 计划 */
export function isLegacyPlanTurnNoAction(turn: number, subtasksLen: number, raw: string): boolean {
  return turn === 0 && subtasksLen === 0 && looksLikeLegacyPlanText(raw)
}

export function looksLikeLegacyPlanText(raw: string): boolean {
  const t = (raw || '').trim()
  if (!t) return false
  return /"(intent|deliverables|foundation)"\s*:/.test(t)
}

/** 执行单个工具动作（与循环解耦，便于单测） */
export async function executeAction(opts: {
  name: string
  args: Record<string, unknown>
  nextIndex: number
  ctx: ToolLoopCtx
  runDeliverable: (d: AgentDeliverable, ctx: ToolLoopCtx) => Promise<{ result: Record<string, unknown>; cost: number; beans: number }>
}): Promise<ToolOutcome> {
  const { name, args, nextIndex, ctx, runDeliverable } = opts
  const emit = ctx.emit as (obj: Record<string, unknown>) => void

  switch (name) {
    case TOOL.askUser: {
      // 参数名容错：模型常不按 schema 来（实测把 questions 写成 question/text/items，
      // 或干脆给个字符串）。只认 questions 会丢掉整段问题、退化成兜底文案，用户什么也看不到。
      let rawQuestions: unknown[] = []
      if (Array.isArray(args.questions)) rawQuestions = args.questions
      else if (Array.isArray(args.question)) rawQuestions = args.question
      else if (typeof args.questions === 'string') rawQuestions = [args.questions]
      else if (typeof args.question === 'string') rawQuestions = [args.question]
      else if (Array.isArray(args.items)) rawQuestions = args.items

      const toQ = (v: unknown): { question: string; options: string[] } | null => {
        if (typeof v === 'string') return v.trim() ? { question: v.trim(), options: [] } : null
        if (!v || typeof v !== 'object') return null
        const o = v as Record<string, unknown>
        const question = asString(o.question) || asString(o.text) || asString(o.q) || asString(o.title)
        if (!question) return null
        return { question, options: asStringArray(o.options) || asStringArray(o.choices) || [] }
      }

      const lines: string[] = []
      // 结构化问题：既用于生成展示文本，也原样给前端渲染成可点选项。
      // 选项文案保留 "A. xxx" 前缀 —— 用户手打"选 A"时也能对上。
      const structured: AskQuestion[] = []
      for (const q of rawQuestions.slice(0, 4)) {
        const parsed = toQ(q)
        if (!parsed) continue
        structured.push({ question: parsed.question, options: parsed.options })
        lines.push(parsed.options.length ? `${parsed.question}\n${parsed.options.map((x) => `  ${x}`).join('\n')}` : parsed.question)
      }
      // 兜底：连问题都解析不出来时，用模型给的 reason/summary 当一句提示，别给空话
      if (lines.length === 0) {
        const fallback = asString(args.reason) || asString(args.summary) || asString(args.message)
        if (fallback) lines.push(fallback)
      }
      // reply 的措辞取决于前端能不能渲染结构化选项：
      //   - 有结构化问题 → reply 只留引导语，问题本身由前端那张可点卡片承载。
      //     否则同一个问题会被渲染两遍（卡片一次 + 这段文字一次）——用户实测到的重复。
      //   - 没有结构化问题（模型只给了纯文字）→ 退回把问题拼进 reply，至少别让用户什么也看不到。
      const reply = structured.length > 0
        ? '需要确认几点，麻烦回复一下：'
        : lines.length
          ? `需要确认几点，麻烦回复一下：\n\n${lines.join('\n\n')}`
          : '请补充一下具体需求，我好继续。'
      // 不在这里 emit agentReply：循环结束后 route 会用 result.reply 统一发一次。
      // 两处都发会让前端收到重复的 agentReply（内容相同、但事件翻倍）。
      return { text: '已向用户提问，等待补充。', done: true, reply, askQuestions: structured.length > 0 ? structured : undefined }
    }

    case TOOL.listModels: {
      const want = asString(args.type)?.toLowerCase()
      const all = (ctx.modelRows as ModelBriefRow[] | undefined) || []
      const list = want ? all.filter((m) => m.capability === want) : all
      // 回填精简清单：只给模型决策必需的字段，省 token
      const text = list.length
        ? JSON.stringify(
            list.map((m) => ({
              id: m.id,
              name: m.name,
              type: m.capability,
              free: m.free,
              ratios: m.ratios,
              tiers: m.tiers,
              ref: m.ref,
              ...(m.capability === 'video'
                ? { resolutions: m.resolutions ?? '', durations: m.durations ?? '' }
                : {}),
            })),
          )
        : '没有匹配的可用模型'
      return { text }
    }

    case TOOL.generateImage: {
      const d = toImageDeliverable(
        args,
        nextIndex,
        ctx.defaultTier as string | null | undefined,
        ctx.defaultImageModelId,
      )
      if (!d.prompt) return { text: 'generate_image 缺少 prompt，请补充画面描述后重试。' }
      const invalid = validateAgentAction(TOOL.generateImage, args, ctx, d)
      if (invalid) return { text: invalid }
      // ===== confirm 闸门：只登记、不执行（真正的花钱发生在用户确认之后）=====
      if (shouldGateActions(ctx.executeMode)) {
        const pending = toPendingAction(d, nextIndex)
        ctx.pendingActions?.push(pending)
        emit({ type: 'pendingAction', action: pending })
        return {
          text: queuedToolText(pending),
          subtask: { id: d.id, title: d.title, type: 'image', status: 'pending', deliverableId: d.id },
        }
      }
      emit({ type: 'subtask', index: nextIndex, label: `${d.title}（image）`, status: 'running', deliverableId: d.id, count: d.count })
      try {
        const { result, cost, beans } = await runDeliverable(d, ctx)
        emit({ type: 'subtask', index: nextIndex, label: d.title, status: 'success' })
        // ⚠️ 回填给模型的文本**不带 URL**。
        //
        // 为什么：这里原本是「产物 URL：[...]」，模型每轮收尾都会把整串链接复述给用户
        // （实测生产：抠图 5 张 → 回复里 5 条裸 URL，占版面又没用）。
        // 图片本来就由成果区展示；让 LLM 复述长链接还有三个害处：
        //   1) 占 token、拖慢响应；2) 容易抄错字符；3) 上游链接是临时的，用户点开可能是坏的。
        // 所以只回「完成了什么 + 张数」，让模型说人话，链接交给成果区。
        const imgCount = Array.isArray(result.imageUrls)
          ? (result.imageUrls as unknown[]).length
          : (result.imageUrl ? 1 : 0)
        const aliases = registerGeneratedImageAssets(ctx, result)
        return {
          text: `已派发并完成「${d.title}」${imgCount > 1 ? `（${imgCount} 张）` : ''}。${aliases.length > 0 ? `新增可引用素材：${aliases.join('、')}。` : ''}产物已进入成果区，前端自动展示，不要在回复里输出任何图片链接或 URL。`,
          subtask: { id: d.id, title: d.title, type: 'image', status: 'success', ...result, ...(aliases.length > 0 ? { assetAliases: aliases } : {}) },
          cost,
          beans,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '生成失败'
        emit({ type: 'subtask', index: nextIndex, label: d.title, status: 'failed', error: msg, deliverableId: d.id })
        // 把失败原因回填给模型：它可以据此换模型/换参数重试（这就是循环的价值）
        return {
          text: `「${d.title}」生成失败：${msg}。可换模型或调整参数后再试。`,
          subtask: { id: d.id, title: d.title, type: 'image', status: 'failed', error: msg },
        }
      }
    }

    case TOOL.generateVideo: {
      const d = toVideoDeliverable(args, nextIndex, ctx.defaultVideoModelId)
      if (!d.prompt) return { text: 'generate_video 缺少 prompt，请补充画面描述后重试。' }
      const invalid = validateAgentAction(TOOL.generateVideo, args, ctx, d)
      if (invalid) return { text: invalid }
      if (shouldGateActions(ctx.executeMode)) {
        const pending = toPendingAction(d, nextIndex)
        ctx.pendingActions?.push(pending)
        emit({ type: 'pendingAction', action: pending })
        return {
          text: queuedToolText(pending),
          subtask: { id: d.id, title: d.title, type: 'video', status: 'pending', deliverableId: d.id },
        }
      }
      emit({ type: 'subtask', index: nextIndex, label: `${d.title}（video）`, status: 'running', deliverableId: d.id, count: 1 })
      try {
        const { result, cost, beans } = await runDeliverable(d, ctx)
        const status = result.videoPending ? 'processing' : 'success'
        emit({ type: 'subtask', index: nextIndex, label: d.title, status, deliverableId: d.id })
        // 同生图：不回填 URL，避免模型复述裸链接（视频更长更易抄错）
        return {
          text: result.videoPending
            ? `「${d.title}」已提交，视频还在后台生成，成果区会持续显示进度。不要说已完成，不要重复提交，也不要输出任务号或视频链接。`
            : `已派发并完成「${d.title}」。产物已进入成果区，前端自动展示，不要在回复里输出任何视频链接或 URL。`,
          subtask: { id: d.id, title: d.title, type: 'video', status, ...result },
          cost,
          beans,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '生成失败'
        emit({ type: 'subtask', index: nextIndex, label: d.title, status: 'failed', error: msg, deliverableId: d.id })
        return {
          text: `「${d.title}」生成失败：${msg}。可换模型或调整参数后再试。`,
          subtask: { id: d.id, title: d.title, type: 'video', status: 'failed', error: msg },
        }
      }
    }

    case TOOL.finish: {
      const summary = asString(args.summary) || '已完成。'
      const decisions = Array.isArray(args.decisions)
        ? (args.decisions as unknown[])
            .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
            .map((d) => ({ label: String(d.label ?? ''), value: String(d.value ?? ''), reason: String(d.reason ?? '') }))
            .filter((d) => d.label && d.value)
            .slice(0, 8)
        : []
      // 同上：统一由 route 收尾 emit，避免重复 agentReply。
      return { text: '已收尾。', done: true, reply: summary, decisions }
    }

    default:
      return { text: `未知工具 ${name}，请改用已提供的工具。` }
  }
}

/**
 * 执行层 guardrail：模型可以犯错，但不能把错误参数直接送到上游。
 *
 * 只做「模型配置里明确声明过」的约束；未声明时保持宽容，避免把历史模型误杀。
 * 校验失败会作为 tool result 回填，让模型下一轮自己改参数。
 */
export function validateAgentAction(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolLoopCtx,
  deliverable: AgentDeliverable,
): string | null {
  const rows = (ctx.modelRows as ModelBriefRow[] | undefined) || []
  const explicitModel = asString(args.model)
  const modelKey = explicitModel || asString(deliverable.model)
  const model = modelKey
    ? rows.find((m) => m.id === modelKey || m.name === modelKey)
    : undefined
  if (explicitModel && !model) {
    return `模型「${modelKey}」不在当前可用清单中。请先调用 list_models，使用返回的 id 后重试。`
  }

  const needCapability = name === TOOL.generateImage ? 'image' : 'video'
  if (model && model.capability !== needCapability) {
    return `模型「${model.name}」不是${needCapability === 'image' ? '图片' : '视频'}模型。请从 list_models 里选择 capability=${needCapability} 的模型。`
  }

  const assetIds = deliverable.assetIds || []
  for (const id of assetIds) {
    if (!isKnownAssetRef(id, ctx)) {
      return `参考图编号「${id}」不在本会话素材池中。只能引用 context.sessionAssets 或本轮上传的图片编号；请先上传图片或改用已存在的编号。`
    }
  }

  if (name === TOOL.generateImage) {
    const ratio = asString(args.ratio)
    const tier = asString(args.tier) || ctx.defaultTier || undefined
    if (ratio && model?.ratios && !model.ratios.split(',').includes(ratio)) {
      return `模型「${model.name}」不支持比例 ${ratio}，可用比例：${model.ratios}。请改用支持的参数后重试。`
    }
    if (tier && model?.tiers && !model.tiers.split(',').includes(tier)) {
      return `模型「${model.name}」不支持档位 ${tier}，可用档位：${model.tiers}。请改用支持的参数后重试。`
    }
    if (
      ratio && tier && model?.sizePairs &&
      !model.sizePairs.split(',').includes(`${ratio}@${tier}`)
    ) {
      return `模型「${model.name}」不支持规格 ${ratio}@${tier}，可用组合：${model.sizePairs}。请改用支持的参数后重试。`
    }
  }

  if (name === TOOL.generateVideo) {
    const ratio = asString(args.ratio)
    const resolution = asString(args.resolution)
    if (ratio && model?.ratios && !model.ratios.split(',').includes(ratio)) {
      return `模型「${model.name}」不支持视频比例 ${ratio}，可用比例：${model.ratios}。请改用支持的参数后重试。`
    }
    if (resolution && model?.resolutions && !model.resolutions.split(',').includes(resolution)) {
      return `模型「${model.name}」不支持清晰度 ${resolution}，可用清晰度：${model.resolutions}。请改用支持的参数后重试。`
    }
    const seconds = asPositiveInt(args.seconds, 1, 600)
    if (seconds && model?.durations && !durationAllowed(seconds, model.durations)) {
      return `模型「${model.name}」不支持 ${seconds} 秒，可用时长：${model.durations}。请改用支持的参数后重试。`
    }
  }

  return null
}

function durationAllowed(seconds: number, raw: string): boolean {
  const text = raw.trim()
  if (!text) return true
  if (/^\d+-\d+$/.test(text)) {
    const [min, max] = text.split('-').map(Number)
    return seconds >= min && seconds <= max
  }
  return text.split(',').map(Number).includes(seconds)
}

function isKnownAssetRef(id: string, ctx: ToolLoopCtx): boolean {
  if (ctx.poolByAlias?.has(id)) return true
  const m = /^图片(\d+)$/.exec(id)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= (ctx.images?.length || 0)
  const numeric = Number(String(id).replace(/\D/g, ''))
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= (ctx.images?.length || 0)
}

/**
 * 本轮产物注册：让「刚生成 → 立即改图 / 立即做视频」在同一次 run 内成立。
 *
 * 只注册图片。视频不是图片参考素材，不能拿 video URL 去充当 image reference。
 */
export function registerGeneratedImageAssets(ctx: ToolLoopCtx, result: Record<string, unknown>): string[] {
  const urls = Array.isArray(result.imageUrls)
    ? result.imageUrls.map(String).filter(Boolean)
    : result.imageUrl ? [String(result.imageUrl)] : []
  if (urls.length === 0) return []
  if (!ctx.poolByAlias) ctx.poolByAlias = new Map()
  if (!ctx.nextGeneratedAssetIndex || ctx.nextGeneratedAssetIndex < 1) {
    const max = [...ctx.poolByAlias.keys()].reduce((n, key) => {
      const m = /^素材(\d+)$/.exec(key)
      return m ? Math.max(n, Number(m[1])) : n
    }, 0)
    ctx.nextGeneratedAssetIndex = max + 1
  }
  const aliases: string[] = []
  for (const url of urls) {
    const alias = `素材${ctx.nextGeneratedAssetIndex++}`
    ctx.poolByAlias.set(alias, url)
    aliases.push(alias)
  }
  return aliases
}
