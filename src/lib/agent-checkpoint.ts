import type { PendingAction } from '@/lib/agent-pending'

/**
 * Agent durable checkpoint。
 *
 * 存在 GenerationTask.payload.agentCheckpoint，不新增表：
 * - 任务本身已经按 userId + clientRequestId 幂等；
 * - payload 是 Prisma Json，适合保存恢复所需的轻量运行态；
 * - 不保存 API Key、provider 凭证或完整上游响应。
 */
export const AGENT_CHECKPOINT_VERSION = 1
export const AGENT_CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 体积上限（台账 Q-D16）：checkpoint 存在 `GenerationTask.payload` 里，
 * 8 轮 × 每轮全量工具结果（图片 URL 列表、上游 JSON）都整份写进去，
 * 长任务的 payload 会持续膨胀且永不回收。
 *
 * **必须在写入侧就封顶**：只在读取侧裁的话，库里那坨字节还在，
 * 每次读任务都要把它整个拉出来。
 */
export const CHECKPOINT_MAX_MESSAGES = 60
export const CHECKPOINT_MAX_CONTENT_CHARS = 4000
export const CHECKPOINT_MAX_TRACE_ENTRIES = 120

const TRUNCATION_MARK = '…[已截断]'

function capContent(content: string): string {
  if (content.length <= CHECKPOINT_MAX_CONTENT_CHARS) return content
  return content.slice(0, CHECKPOINT_MAX_CONTENT_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK
}

/**
 * 保留**尾部**若干条，并保证不以孤立的 tool 结果开头：
 * 一条 `role:'tool'` 必须紧跟在它对应的 assistant tool_calls 之后，
 * 否则恢复出来的消息序列对上游非法（部分上游直接 400）。
 */
function capMessages(list: AgentCheckpointMessage[]): AgentCheckpointMessage[] {
  if (list.length <= CHECKPOINT_MAX_MESSAGES) return list
  let start = list.length - CHECKPOINT_MAX_MESSAGES
  while (start < list.length && list[start].role === 'tool') start++
  return list.slice(start)
}

export type AgentCheckpointMessage = {
  role: string
  content: string
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

export type AgentCheckpointDecision = {
  label: string
  value: string
  reason: string
}

export type AgentCheckpointQuestion = {
  question: string
  options: string[]
}

export type AgentCheckpointTrace = {
  turn: number
  action: string
  modelId?: string
  status: 'success' | 'failed' | 'blocked' | 'cancelled'
  durationMs: number
  cost?: number
  beans?: number
  detail?: string
}

export type AgentCheckpoint = {
  version: typeof AGENT_CHECKPOINT_VERSION
  taskId: string
  userId: string
  createdAt: string
  updatedAt: string
  /** 已完成的规划轮次；恢复时从下一轮继续 */
  turn: number
  /** 已执行的工具动作数（不是规划轮次） */
  actionCount: number
  messages: AgentCheckpointMessage[]
  deliverableIndex: number
  subtasks: Record<string, unknown>[]
  totalCost: number
  totalBeans: number
  lastText: string
  decisions: AgentCheckpointDecision[]
  askQuestions?: AgentCheckpointQuestion[]
  pendingActions?: PendingAction[]
  /** 本 run 内新生成图片的编号 → URL；恢复后仍能引用“素材N” */
  assetAliases: Record<string, string>
  nextGeneratedAssetIndex: number
  agentTrace: AgentCheckpointTrace[]
  finished: boolean
}

type ExpectedCheckpoint = {
  taskId: string
  userId: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function normalizeMessages(v: unknown): AgentCheckpointMessage[] {
  if (!Array.isArray(v)) return []
  const list: AgentCheckpointMessage[] = v.flatMap((item) => {
    if (!isObject(item) || typeof item.role !== 'string') return []
    const content = typeof item.content === 'string' ? item.content : ''
    return [{
      role: item.role,
      // 单条正文封顶（Q-D16）：工具回填的上游 JSON / URL 列表动辄几十 KB
      content: capContent(content),
      ...(item.tool_calls !== undefined ? { tool_calls: item.tool_calls } : {}),
      ...(typeof item.tool_call_id === 'string' ? { tool_call_id: item.tool_call_id } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
    }]
  })
  return capMessages(list)
}

function normalizeDecisions(v: unknown): AgentCheckpointDecision[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((item) => {
    if (!isObject(item)) return []
    const label = typeof item.label === 'string' ? item.label : ''
    const value = typeof item.value === 'string' ? item.value : ''
    if (!label || !value) return []
    return [{ label, value, reason: typeof item.reason === 'string' ? item.reason : '' }]
  })
}

function normalizeQuestions(v: unknown): AgentCheckpointQuestion[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.flatMap((item) => {
    if (!isObject(item) || typeof item.question !== 'string' || !item.question) return []
    return [{ question: item.question, options: asStringArray(item.options) }]
  })
  return out.length > 0 ? out : undefined
}

function normalizePendingActions(v: unknown): PendingAction[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((item): item is PendingAction => {
    if (!isObject(item)) return false
    return typeof item.id === 'string'
      && typeof item.kind === 'string'
      && typeof item.title === 'string'
      && typeof item.prompt === 'string'
      && typeof item.count === 'number'
  })
  return out.length > 0 ? out : undefined
}

function normalizeTrace(v: unknown): AgentCheckpointTrace[] {
  if (!Array.isArray(v)) return []
  const list: AgentCheckpointTrace[] = v.flatMap((item) => {
    if (!isObject(item)) return []
    const status = item.status
    if (
      typeof item.turn !== 'number'
      || typeof item.action !== 'string'
      || typeof item.durationMs !== 'number'
      || (status !== 'success' && status !== 'failed' && status !== 'blocked' && status !== 'cancelled')
    ) return []
    return [{
      turn: item.turn,
      action: item.action,
      status,
      durationMs: item.durationMs,
      ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}),
      ...(typeof item.cost === 'number' ? { cost: item.cost } : {}),
      ...(typeof item.beans === 'number' ? { beans: item.beans } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    }]
  })
  // trace 只用于事后排查，保留最近若干条即可（旧实现整份写进 payload）
  return list.length > CHECKPOINT_MAX_TRACE_ENTRIES
    ? list.slice(list.length - CHECKPOINT_MAX_TRACE_ENTRIES)
    : list
}

/**
 * 写入侧封顶：`makeCheckpoint` 组好对象后过一遍，保证进库的 payload 已经是有界的。
 * 与 parse 侧共用同一组常量，避免「写的时候不限、读的时候才裁」导致库里继续膨胀。
 */
export function sanitizeCheckpoint(cp: AgentCheckpoint): AgentCheckpoint {
  return {
    ...cp,
    messages: capMessages(cp.messages.map((m) => ({ ...m, content: capContent(m.content) }))),
    agentTrace: cp.agentTrace.length > CHECKPOINT_MAX_TRACE_ENTRIES
      ? cp.agentTrace.slice(cp.agentTrace.length - CHECKPOINT_MAX_TRACE_ENTRIES)
      : cp.agentTrace,
    lastText: capContent(cp.lastText),
  }
}

export function parseAgentCheckpoint(value: unknown, expected: ExpectedCheckpoint): AgentCheckpoint | null {
  if (!isObject(value)) return null
  if (value.version !== AGENT_CHECKPOINT_VERSION) return null
  if (value.taskId !== expected.taskId || value.userId !== expected.userId) return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return null

  const assetAliases: Record<string, string> = {}
  if (isObject(value.assetAliases)) {
    for (const [alias, url] of Object.entries(value.assetAliases)) {
      if (/^素材\d+$/.test(alias) && typeof url === 'string' && url.length > 0) {
        assetAliases[alias] = url
      }
    }
  }

  const subtasks = Array.isArray(value.subtasks)
    ? value.subtasks.filter(isObject)
    : []

  return {
    version: AGENT_CHECKPOINT_VERSION,
    taskId: value.taskId,
    userId: value.userId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    turn: typeof value.turn === 'number' && value.turn >= 0 ? Math.floor(value.turn) : 0,
    actionCount: typeof value.actionCount === 'number' && value.actionCount >= 0 ? Math.floor(value.actionCount) : 0,
    messages: normalizeMessages(value.messages),
    deliverableIndex: typeof value.deliverableIndex === 'number' && value.deliverableIndex >= 0 ? Math.floor(value.deliverableIndex) : 0,
    subtasks,
    totalCost: typeof value.totalCost === 'number' && Number.isFinite(value.totalCost) ? value.totalCost : 0,
    totalBeans: typeof value.totalBeans === 'number' && Number.isFinite(value.totalBeans) ? value.totalBeans : 0,
    lastText: typeof value.lastText === 'string' ? value.lastText : '',
    decisions: normalizeDecisions(value.decisions),
    askQuestions: normalizeQuestions(value.askQuestions),
    pendingActions: normalizePendingActions(value.pendingActions),
    assetAliases,
    nextGeneratedAssetIndex: typeof value.nextGeneratedAssetIndex === 'number' && value.nextGeneratedAssetIndex >= 1
      ? Math.floor(value.nextGeneratedAssetIndex)
      : 1,
    agentTrace: normalizeTrace(value.agentTrace),
    finished: value.finished === true,
  }
}

/**
 * 检查点是否过期（Q-D16 残留项）。
 *
 * 旧实现只信 `checkpoint.updatedAt` —— 那是**检查点自己写的字符串**，
 * 一旦时钟偏移、或被手工/异常写入一个未来时间，7 天 TTL 就永远不会到期，
 * 一个早已无意义的检查点还能被拿来恢复（重新扣费的入口）。
 *
 * 现在：
 *   - 时间戳在未来（超过允许的时钟偏移）直接判失效；
 *   - 传入数据库侧 `taskUpdatedAt` 时，取两者中**更早**的那个算年龄
 *     —— 库内时间是服务端写的，调用方伪造不了。
 * 两者都拿不到时行为不变（保守：宁可拒绝恢复也不能无限期恢复）。
 */
export function isAgentCheckpointExpired(
  checkpoint: AgentCheckpoint,
  now = Date.now(),
  serverUpdatedAt?: Date | null,
): boolean {
  const updatedAt = Date.parse(checkpoint.updatedAt)
  if (!Number.isFinite(updatedAt)) return true
  // 允许 5 分钟的时钟偏移（容器时区/NTP 同步抖动），再往前的时间戳不可信
  const CLOCK_SKEW_MS = 5 * 60 * 1000
  if (updatedAt > now + CLOCK_SKEW_MS) return true
  const serverTime = serverUpdatedAt ? serverUpdatedAt.getTime() : Number.NaN
  const effective = Number.isFinite(serverTime) ? Math.min(updatedAt, serverTime) : updatedAt
  return now - effective > AGENT_CHECKPOINT_TTL_MS
}
