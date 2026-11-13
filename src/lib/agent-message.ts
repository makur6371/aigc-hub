// Agent 会话消息：**归一化的唯一实现**。
//
// ===== 为什么单独成文件 =====
// 同一个「消息 → 界面模型」的映射原本写了两遍：
//   1) 实时 SSE 事件（ToolAgentPanel 的 handleEvent）
//   2) 历史回显（ToolAgentPanel 的 openHistorySession）
// 两份实现立刻就开始漂移 —— 历史那边漏掉了 decisions/plan，error 被写死成 null，
// 于是「同一个会话，刚聊完是完整卡片，刷新重开就只剩一行字」。
// 每加一个字段都要记得改两处，迟早再漏。
//
// 所以把映射收敛到这里，两条路径都走它。新增字段时只改这一个文件。
//
// ⚠️ 纯函数、无副作用、无 IO —— 可以直接单测（见 tests/agent-message.test.ts）。

/** ask_user 的结构化问题（后端 AskQuestion 形状） */
export type AskQuestion = {
  question: string
  options: string[]
}

/** Agent 给出的关键决策（模型/比例/档位…），用于「用了什么参数」卡片 */
export type AgentDecision = {
  label: string
  value: string
  reason: string
}

/**
 * 待确认的执行项（confirm 模式）。
 *
 * 与后端 PendingAction 对齐，但前端只读展示 —— 用户在确认卡上看清
 * 「要做什么、用什么提示词、什么参数、大概花多少」，再决定执行或放弃。
 */
export type PendingActionView = {
  id: string
  kind: 'image' | 'video' | 'audio' | 'text'
  title: string
  modelId?: string
  /** 完整提示词（确认卡的核心） */
  prompt: string
  count: number
  ratio?: string
  quality?: string
  resolution?: string
  seconds?: number
  voice?: string
  estimate?: { points: number | null; beans: number | null }
}

/** 执行计划（规划阶段 + 每个子任务的实时状态） */
export type AgentPlan = {
  title: string
  steps: { label: string; status: 'running' | 'success' | 'failed' | 'pending'; videoRecordIds?: string[] }[]
}

/**
 * 把「用户对结构化问题的选择」拼成一条自然语言回复。
 *
 * ask_user 一次可以问多个问题（多选题），前端把每题的选择各拼一行、一次发完。
 * 单题是它的退化情形（只有一行）。
 *
 * @param questions 该轮 Agent 反问的问题列表（顺序即展示顺序）
 * @param picked    已作答的选择：键为问题下标，值为选项文案
 */
export function composeAnswerMessage(
  questions: AskQuestion[],
  picked: Record<number, string | undefined>,
): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const choice = picked[i]
    if (choice) lines.push(`关于「${q.question}」，我选：${choice}`)
  })
  return lines.join('\n')
}
/** 界面上一条消息的完整形状（实时与历史共用） */
export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'pending' | 'done' | 'failed'
  error?: string
  images?: string[]
  askQuestions?: AskQuestion[]
  decisions?: AgentDecision[]
  /** 规划阶段的流式思考过程（边思考边输出） */
  thinking?: string
  plan?: AgentPlan
  /** confirm 模式：等待用户确认的执行项（有值时渲染确认卡） */
  pendingActions?: PendingActionView[]
  /** 待确认任务 id（确认/放弃接口要用） */
  pendingTaskId?: string
  /** 该条回复对应的 Agent 任务 id（失败后从检查点继续要用） */
  taskId?: string
  /** 已修订轮次（0/undefined = 原始方案；用于展示「第 N 版」） */
  revisionRound?: number
}

/** 只保留有题干的问题；选项去掉空串 */
export function normalizeAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((q) => {
      const o = (q || {}) as Record<string, unknown>
      return {
        question: String(o.question || ''),
        // String(null) === 'null' —— 必须先把 null/undefined 滤掉再转字符串，
        // 否则选项里会冒出一条字面量 'null'（测试抓到的真实缺陷）。
        options: Array.isArray(o.options)
          ? (o.options as unknown[]).filter((x) => x !== null && x !== undefined).map(String).filter(Boolean)
          : [],
      }
    })
    .filter((q) => q.question)
}

/**
 * 归一化决策列表。
 *
 * 模型/后端给的形状并不总是规整：可能缺 reason、value 是数字、
 * 甚至整条是字符串。这里统一成 { label, value, reason } 且都非空 ——
 * 否则前端要到处写 `?? ''`，或者渲染出「模型： undefined」这种行。
 */
export function normalizeDecisions(raw: unknown): AgentDecision[] {
  if (!Array.isArray(raw)) return []
  const out: AgentDecision[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const label = String(o.label ?? '').trim()
    const value = o.value === null || o.value === undefined ? '' : String(o.value).trim()
    if (!label || !value) continue
    out.push({ label, value, reason: String(o.reason ?? '').trim() })
  }
  return out
}

/**
 * 归一化待确认项。
 *
 * 后端的 PendingAction 来自模型输出，字段可能缺、可能是数字/字符串混用，
 * 这里统一成前端能直接渲染的形状；**没有 prompt 的直接丢弃** ——
 * 让用户确认一个看不到内容的动作没有意义。
 */
export function normalizePendingActions(raw: unknown): PendingActionView[] {
  if (!Array.isArray(raw)) return []
  const out: PendingActionView[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const prompt = String(o.prompt ?? '').trim()
    if (!prompt) continue
    const kindRaw = String(o.kind ?? '')
    const kind: PendingActionView['kind'] =
      kindRaw === 'image' || kindRaw === 'video' || kindRaw === 'audio' ? kindRaw : 'text'
    const n = Number(o.count)
    const est = (o.estimate || null) as Record<string, unknown> | null
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    out.push({
      id: String(o.id ?? `pending-${out.length}`),
      kind,
      title: String(o.title ?? '').trim() || `第 ${out.length + 1} 步`,
      modelId: typeof o.modelId === 'string' ? o.modelId : undefined,
      prompt,
      count: Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1,
      ratio: typeof o.ratio === 'string' ? o.ratio : undefined,
      quality: typeof o.quality === 'string' ? o.quality : undefined,
      resolution: typeof o.resolution === 'string' ? o.resolution : undefined,
      seconds: typeof o.seconds === 'number' ? o.seconds : undefined,
      voice: typeof o.voice === 'string' ? o.voice : undefined,
      estimate: est ? { points: num(est.points), beans: num(est.beans) } : undefined,
    })
  }
  return out
}

/**
 * 由后端 subtasks 还原「执行计划」卡片。
 *
 * 为什么能从 subtasks 还原：executor 里每个交付物跑时都会 push
 * `{ id, title, type, status, error? }`，并**随 task.payload 落库**。
 * 所以历史会话也能拿到完整的每步结果 —— 只是前端以前没读。
 *
 * 只认成功的尝试会被漏掉：cancelled / failed 也要显示（否则用户看到
 * 「计划里有 5 步」却只显示 3 步，像丢数据）。
 */
export function planFromSubtasks(raw: unknown): AgentPlan | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const steps: AgentPlan['steps'] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const label = String(o.title ?? '').trim()
    if (!label) continue
    const st = String(o.status ?? '')
    const videoRecordIds = Array.isArray(o.pendingRecordIds)
      ? o.pendingRecordIds.filter((id): id is string => typeof id === 'string' && !!id)
      : typeof o.recordId === 'string' && o.videoPending ? [o.recordId] : []
    steps.push({
      label,
      // pending = confirm 模式下「已规划、等用户确认」，不是失败。
      status: o.videoPending || st === 'processing' ? 'running' : st === 'success' ? 'success' : st === 'running' ? 'running' : st === 'pending' ? 'pending' : 'failed',
      ...(videoRecordIds.length ? { videoRecordIds } : {}),
    })
  }
  return steps.length > 0 ? { title: '执行计划', steps } : undefined
}

export function resolveVideoPlanSteps(
  steps: AgentPlan['steps'],
  results: Array<{ claimedRunId?: string; status: string }>,
): AgentPlan['steps'] {
  return steps.map((step) => {
    if (!step.videoRecordIds?.length) return step
    const states = step.videoRecordIds.map((id) => results.find((item) => item.claimedRunId === `video:${id}`)?.status)
    const status = states.some((state) => state === 'error') ? 'failed'
      : states.every((state) => state === 'done') ? 'success' : 'running'
    return { ...step, status }
  })
}

/** 历史消息（/api/agent/sessions/[id]/messages）→ 界面消息 */
export function messageFromHistoryRecord(m: {
  id?: unknown
  role?: unknown
  content?: unknown
  status?: unknown
  mediaUrls?: unknown
  meta?: unknown
}): AgentMessage {
  const meta = (m.meta || null) as Record<string, unknown> | null
  // 用户上传的图在 meta.images；助手产物在 mediaUrls。两边都收，顺序保持「先上传后产物」。
  const fromMeta = Array.isArray(meta?.images) ? (meta!.images as string[]) : []
  const fromMedia = Array.isArray(m.mediaUrls) ? (m.mediaUrls as string[]) : []
  const images = [...fromMeta, ...fromMedia].filter((u) => typeof u === 'string' && u)

  const askQuestions = normalizeAskQuestions(meta?.askQuestions)
  const decisions = normalizeDecisions(meta?.decisions)
  const plan = planFromSubtasks(meta?.subtasks)
  const pendingActions = normalizePendingActions(meta?.pendingActions)
  // 失败原因以前被后端写死成 null（messages/route.ts），真实原因一直在 meta.error 里
  const error = typeof meta?.error === 'string' && meta.error ? meta.error : undefined
  const content = String(m.content || '')

  return {
    id: String(m.id ?? ''),
    role: m.role === 'user' ? 'user' : 'assistant',
    content,
    // 状态优先看后端 status；再兜底：有 error 就是失败，否则完成
    status: m.status === 'failed' || error ? 'failed' : 'done',
    error,
    images: images.length > 0 ? images : undefined,
    askQuestions: askQuestions.length > 0 ? askQuestions : undefined,
    decisions: decisions.length > 0 ? decisions : undefined,
    plan,
    pendingActions: pendingActions.length > 0 ? pendingActions : undefined,
    pendingTaskId: typeof meta?.taskId === 'string' ? meta.taskId : undefined,
    taskId: typeof meta?.taskId === 'string' ? meta.taskId : undefined,
    revisionRound:
      typeof meta?.revisionRound === 'number' && Number.isFinite(meta.revisionRound) && meta.revisionRound > 0
        ? meta.revisionRound
        : undefined,
  }
}
