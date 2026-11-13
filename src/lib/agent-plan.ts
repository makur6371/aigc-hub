// VOZEB-PRO 借鉴的完整 create_agent_plan 计划协议
// 结构：intent / objective / audience / reply / decisions / foundation / deliverables / projectHandoff

import { resolveVideoBeans } from '@/lib/billing/billing-plans'
import { getVideoCapabilities, normalizeVideoResolution, DEFAULT_VIDEO_RESOLUTIONS, DEFAULT_VIDEO_RATIOS } from '@/lib/video-capabilities'
import { decodeSize, getImageCapabilities } from '@/lib/image-sizes'
import { ORG } from '@/lib/site-content'

export type AgentIntent = 'conversation' | 'generation'

export type DeliverableType = 'text' | 'image' | 'video' | 'audio'

export interface AgentDecision {
  label: string
  value: string
  reason: string
}

export interface AgentFoundation {
  complexity: 'simple' | 'complex'
  brief: {
    objective: string
    audience?: string
    usage?: string
    coreMessage?: string
    constraints?: string[]
    referenceStrategy?: string
  }
  direction: {
    summary: string
    style?: string
    composition?: string
    colors?: string[]
    lighting?: string
    keywords?: string[]
    avoid?: string[]
  }
}

export interface AgentDeliverable {
  id?: string
  title: string
  type: DeliverableType
  model?: string
  prompt: string
  count?: number
  ratio?: string
  quality?: string
  /**
   * 视频清晰度档（canonical，如 480P/768P/1080P/2K）。
   * 与 image 的 quality（1K/2K/4K）分开：视频上游的档位枚举不同
   */
  resolution?: string
  seconds?: number
  voice?: string
  dependencies?: string[]
  assetIds?: string[]
}

export interface AgentProjectHandoff {
  surface: 'canvas' | 'drama'
  title: string
  summary?: string
  style?: string
  ratio?: '9:16' | '16:9'
  assetIds?: string[]
}

export interface AgentPlan {
  intent: AgentIntent
  objective: string
  audience?: string
  reply: string
  decisions: AgentDecision[]
  foundation: AgentFoundation
  deliverables: AgentDeliverable[]
  projectHandoff?: AgentProjectHandoff
}

// ===== 校验 =====
export function validateAgentPlan(plan: unknown): AgentPlan {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('模型返回的创作计划无效')
  }
  const p = plan as Record<string, unknown>

  const intent: AgentIntent = p.intent === 'generation' ? 'generation' : 'conversation'
  const objective = typeof p.objective === 'string' && p.objective.trim() ? p.objective.trim() : intent === 'generation' ? '创作' : '普通对话'
  const reply = typeof p.reply === 'string' && p.reply.trim() ? p.reply.trim() : ''

  // decisions
  const decisions: AgentDecision[] = Array.isArray(p.decisions)
    ? (p.decisions as unknown[]).filter((d): d is AgentDecision => {
        if (!d || typeof d !== 'object') return false
        const o = d as Record<string, unknown>
        return typeof o.label === 'string' && typeof o.value === 'string' && typeof o.reason === 'string'
      }).slice(0, 8)
    : []

  // foundation
  const rawF = (p.foundation && typeof p.foundation === 'object') ? p.foundation as Record<string, unknown> : {}
  const rawBrief = (rawF.brief && typeof rawF.brief === 'object') ? rawF.brief as Record<string, unknown> : {}
  const rawDir = (rawF.direction && typeof rawF.direction === 'object') ? rawF.direction as Record<string, unknown> : {}
  const foundation: AgentFoundation = {
    complexity: rawF.complexity === 'complex' ? 'complex' : 'simple',
    brief: {
      objective: typeof rawBrief.objective === 'string' && rawBrief.objective.trim() ? rawBrief.objective.trim() : objective,
      audience: typeof rawBrief.audience === 'string' ? rawBrief.audience : undefined,
      usage: typeof rawBrief.usage === 'string' ? rawBrief.usage : undefined,
      coreMessage: typeof rawBrief.coreMessage === 'string' ? rawBrief.coreMessage : undefined,
      constraints: Array.isArray(rawBrief.constraints) ? (rawBrief.constraints as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10) : undefined,
      referenceStrategy: typeof rawBrief.referenceStrategy === 'string' ? rawBrief.referenceStrategy : undefined,
    },
    direction: {
      summary: typeof rawDir.summary === 'string' && rawDir.summary.trim() ? rawDir.summary.trim() : '保持主体、信息和视觉语言一致',
      style: typeof rawDir.style === 'string' ? rawDir.style : undefined,
      composition: typeof rawDir.composition === 'string' ? rawDir.composition : undefined,
      colors: Array.isArray(rawDir.colors) ? (rawDir.colors as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6) : undefined,
      lighting: typeof rawDir.lighting === 'string' ? rawDir.lighting : undefined,
      keywords: Array.isArray(rawDir.keywords) ? (rawDir.keywords as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 8) : undefined,
      avoid: Array.isArray(rawDir.avoid) ? (rawDir.avoid as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 8) : undefined,
    },
  }

  // deliverables
  const deliverables: AgentDeliverable[] = Array.isArray(p.deliverables)
    ? (p.deliverables as unknown[]).filter((d): d is AgentDeliverable => {
        if (!d || typeof d !== 'object') return false
        const o = d as Record<string, unknown>
        if (typeof o.prompt !== 'string' || !o.prompt.trim()) return false
        const type = String(o.type || '')
        if (!['text', 'image', 'video', 'audio'].includes(type)) return false
        return true
      }).map((d, idx) => ({
        id: typeof d.id === 'string' && d.id.trim() ? d.id.trim() : `task-${idx}`,
        title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : (d.type === 'text' ? '文本' : d.type === 'image' ? '图片' : d.type === 'video' ? '视频' : '音频'),
        type: d.type,
        model: typeof d.model === 'string' ? d.model : undefined,
        prompt: d.prompt.trim(),
        count: toPositiveInt(d.count, 1, 8),
        ratio: typeof d.ratio === 'string' ? d.ratio : undefined,
        quality: typeof d.quality === 'string' ? d.quality : undefined,
        resolution: typeof d.resolution === 'string' ? d.resolution : undefined,
        seconds: toPositiveInt(d.seconds, 1, 600) ?? undefined,
        voice: typeof d.voice === 'string' ? d.voice : undefined,
        dependencies: Array.isArray(d.dependencies) ? (d.dependencies as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
        assetIds: Array.isArray(d.assetIds) ? (d.assetIds as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
      })).slice(0, 12)
    : []

  // projectHandoff
  let projectHandoff: AgentProjectHandoff | undefined
  if (p.projectHandoff && typeof p.projectHandoff === 'object') {
    const h = p.projectHandoff as Record<string, unknown>
    const surface = h.surface === 'canvas' ? 'canvas' : h.surface === 'drama' ? 'drama' : 'canvas'
    const title = typeof h.title === 'string' && h.title.trim() ? h.title.trim() : objective
    projectHandoff = {
      surface,
      title,
      summary: typeof h.summary === 'string' ? h.summary : undefined,
      style: typeof h.style === 'string' ? h.style : undefined,
      ratio: h.ratio === '9:16' || h.ratio === '16:9' ? h.ratio : undefined,
      assetIds: Array.isArray(h.assetIds) ? (h.assetIds as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
    }
  }

  if (intent === 'conversation') {
    // 闲聊：无交付物，直接回复
    return { intent, objective, audience: typeof p.audience === 'string' ? p.audience : undefined, reply: reply || '好的', decisions: [], foundation, deliverables: [] }
  }

  if (deliverables.length === 0) {
    // 模型返回 generation 意图但没规划任何 deliverable（常见于「缺参追问」场景）：
    // 不抛错，降级为 conversation 语义——reply 直接透给用户，避免整条任务失败。
    return { intent: 'conversation', objective, audience: typeof p.audience === 'string' ? p.audience : undefined, reply: reply || '好的', decisions, foundation, deliverables: [] }
  }

  return { intent, objective, audience: typeof p.audience === 'string' ? p.audience : undefined, reply, decisions, foundation, deliverables, projectHandoff }
}

/** 宽松取正整数：兼容 "4" / 4 / [4] / [] / null 等模型常见畸形输出 */
function toPositiveInt(v: unknown, min: number, max: number): number {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v)
  if (!Number.isFinite(n) || n < min) return min
  return Math.min(Math.round(n), max)
}

/**
 * 规划解析结果 + 诊断。
 *
 * 为什么需要 degraded：解析失败目前会被静默降级成「对话」——空回复 + 0 交付物，
 * 任务被判 SUCCEEDED、调用日志 200，用户却什么都拿不到，排查时完全看不出问题
 * （2026-09-29 场景 2 实测：上游 200 空响应 → 无任何生图请求）。
 * 有了标记，executor 才能把「上游给了垃圾」和「用户就是在闲聊」区分开，前者走重试/降级。
 */
export interface AgentPlanParseResult {
  plan: AgentPlan
  /** 上游输出不可用（空/无法解析），已降级为兜底对话 */
  degraded: boolean
  /** 降级原因（写入调用日志，便于运维面板直接看到） */
  reason?: string
}

// ===== JSON 容错解析 =====
// 模型输出的 JSON 常见问题：尾随逗号、字符串内裸换行、中文引号、数值字段给了空数组。
// 这里做逐级放宽，尽量把「本可解析」的输出救回来，避免一遇符号问题就整条对话中断。
function tryParseLoose(raw: string): unknown {
  const attempts: string[] = []
  attempts.push(raw)
  // 1) 去掉尾随逗号
  attempts.push(raw.replace(/,\s*([}\]])/g, '$1'))
  // 2) 把字符串内的裸换行/制表转义（粗略但有效：仅处理成对引号之间）
  attempts.push(raw.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')))
  // 3) 中文引号 → 英文引号
  attempts.push(raw.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"))
  // 4) 组合：去尾随逗号 + 转义换行
  attempts.push(raw.replace(/,\s*([}\]])/g, '$1').replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\n/g, '\\n')))
  for (const a of attempts) {
    try { return JSON.parse(a) } catch { /* next */ }
  }
  return null
}

/**
 * 截断补救：模型输出被 max_tokens 掐断时，JSON 会差最后几个闭合符。
 * 实测（2026-09-28）：规划输出 open=9 close=8（差一个 }），整段被当纯文本
 * 塞进了 reply → 用户看到一坨 JSON。
 *
 * 这里对「以 { 开头且从未出现配平对象」的文本做闭合符补齐（按栈序补 } 与 ]），
 * 然后再走一次标准解析。补不回来就返回 null（交回纯文本兜底）。
 */
/**
 * 截断补救（v2）：
 *
 * 模型输出被 max_tokens 掐断时，常见两种坏 JSON：
 * 1) 末尾缺闭合符（栈不空）→ 按栈序补 } 或 ]；
 * 2) 中间漏写一个闭合符导致类型错位（栈恰好配平但 JSON.parse 失败）
 *    → 尝试常见修正后缀如 ]}] 逐个测试。
 *
 * 两种都救不回来时返回 null，交回纯文本兜底。
 */
function tryRepairTruncated(text: string): unknown {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  // 类型匹配栈扫描
  const stack: string[] = []
  let inString = false
  let escaped = false
  let typeMismatch = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop()
      } else {
        typeMismatch = true
      }
    }
  }
  if (stack.length === 0 && !typeMismatch) return null
  let repaired = t
  if (inString) repaired += '"'
  if (stack.length > 0) repaired += stack.reverse().join('')
  let result = tryParseLoose(repaired)
  if (result !== null) return result
  if (typeMismatch || stack.length === 0) {
    for (const fix of ['\u005d\u007d\u005d\u007d', '\u005d\u007d\u005d', '\u005d\u007d', '\u007d\u005d', '\u007d\u007d\u005d']) {
      const cand = repaired.replace(/[\u005d\u007d]+$/, '') + fix
      result = tryParseLoose(cand)
      if (result !== null) return result
    }
  }
  return null
}
function extractBalancedObjects(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    let depth = 0
    let inString = false
    let escaped = false
    let closed = -1
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { closed = j; break }
      }
    }
    if (closed === -1) break // 未配平到底：后面也不会有完整对象
    out.push(text.slice(i, closed + 1))
    i = closed + 1
  }
  return out
}
// 从 LLM 输出提取计划（支持 function-call 参数 / 裸 JSON / markdown 围栏）
/** 兼容入口：只要计划本体（测试与旧调用方用） */
export function parseAgentPlan(content: string): AgentPlan {
  return parseAgentPlanWithDiagnostics(content).plan
}

export function parseAgentPlanWithDiagnostics(content: string): AgentPlanParseResult {
  let text = content.trim()

  // 上游 200 但正文为空（SSE 空流 / 被网关吞掉 / 模型未吐任何 token）：
  // 必须显式标记 degraded。否则会伪装成「用户闲聊」→ 任务 SUCCEEDED、日志 200、
  // 零交付物，用户看不到任何结果也查不出原因（2026-09-29 场景 2 实测）。
  if (!text) {
    return {
      plan: { intent: 'conversation', objective: '上游返回空内容', reply: '', decisions: [], foundation: { complexity: 'simple', brief: { objective: '上游返回空内容' }, direction: { summary: '' } }, deliverables: [] },
      degraded: true,
      reason: '上游返回空内容（可能被网关截断或模型未输出）',
    }
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  // 尝试解析"arguments":"{...}" 形式的 function call 参数（模型可能把 JSON 嵌在字符串里）
  const argMatch = text.match(/"arguments"\s*:\s*"(\{[\s\S]*?\})"/)
  if (argMatch) {
    try {
      const decoded = argMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
      const plan = JSON.parse(decoded)
      return { plan: validateAgentPlan(plan), degraded: false }
    } catch { /* fallthrough */ }
  }

  // 从混杂文本里取出「第一个配平的 JSON 对象」。
  //
  // 为什么不能再用 indexOf('{') + lastIndexOf('}'）：模型常把「思考」和「计划」写在一起，
  // 思考里若出现过一段 JSON，最后一个 '}' 就落到计划外面，截出来的字符串跨了两个对象，
  // 必然 JSON.parse 失败 → 用户看到「这次没理解好」。
  // 实测复现：'分析:{"需求":1} 计划:{"intent":...}' → 旧逻辑必失败。
  // 改用配平括号扫描（跳过字符串内的括号），与 lib/json-blocks 的 extractJsonBody 同口径。
  const bodies = extractBalancedObjects(text)
  if (bodies.length === 0) {
    // 截断补救：输出被 max_tokens 掐断（括号不配平）时，补闭合再解析一次。
    // 修好就是完整计划（正常执行生图）；修不回才是真正的纯文本对话。
    const repaired = tryRepairTruncated(text)
    if (repaired && typeof repaired === 'object') {
      return { plan: validateAgentPlan(repaired), degraded: false, reason: '输出被截断，已自动补全闭合符' }
    }
    // 纯文本兜底：当普通对话（合法语义，不标 degraded）
    return {
      plan: { intent: 'conversation', objective: text.slice(0, 50), reply: text, decisions: [], foundation: { complexity: 'simple', brief: { objective: text.slice(0, 50) }, direction: { summary: '' } }, deliverables: [] },
      degraded: false,
    }
  }
  // 优先选「像计划」的那个（含 intent 字段）；都不像就取第一个。
  let parsed: unknown = null
  const ranked = [
    ...bodies.filter((b) => /"intent"\s*:/.test(b)),
    ...bodies.filter((b) => !/"intent"\s*:/.test(b)),
  ]
  for (const body of ranked) {
    const hit = tryParseLoose(body)
    if (hit && typeof hit === 'object') { parsed = hit; break }
  }
  if (!parsed) {
    // 彻底解析失败：不要把原始 JSON 当回复泄漏给用户，给一句可行动的提示
    console.warn('[agent-plan] 计划 JSON 解析失败，已降级为提示回复。前 200 字:', ranked[0]?.slice(0, 200))
    return {
      plan: { intent: 'conversation', objective: '解析失败', reply: '这次没理解好，麻烦再发一次或换个说法🙏', decisions: [], foundation: { complexity: 'simple', brief: { objective: '解析失败' }, direction: { summary: '' } }, deliverables: [] },
      degraded: true,
      reason: '规划输出不是合法 JSON（截断补救也失败）',
    }
  }
  return { plan: validateAgentPlan(parsed), degraded: false }
}

// 生成规划 system prompt（借鉴 VOZEB planner 要点，中文）
// ===== 规划器可用模型清单 =====
//
// 为什么 planner 需要知道 prices/sizes：system prompt 要求「每个 image deliverable
// 必须填 model 与 ratio」，但旧版 modelBrief 只有 id/name/capability —— 模型无从知道
// 哪个模型支持 3:4、哪个只支持 1K、哪个免费，只能瞎猜（猜错靠执行期尺寸吸附兜底，
// 表现为「用户要的比例被改了」）。
//
// 数据源就是模型配置里已有的 metadata.sizes（"ratio@tier" 编码）+ tierCost*/costPoints，
// 这里做的是**压缩成 planner 友好的两个维度**（ratios/tiers），而不是透传 24 项数组
// —— token 预算：15 模型增强后约 +2.8KB（≈1K token），对 300s 的规划调用完全可接受。

/** 一个交付模型能力摘要（发给规划器的 availableModels 数组项） */
export interface PlannerModelBrief {
  id: string
  name: string
  capability: string
  /** 是否免费（isFree 或 costPoints=0） */
  free: boolean
  /** 档位单价串，如 "5/6/7"（1K/2K/4K）；无档位差价时为单值 "5" */
  cost: string
  /** 支持的画幅比例（去重排序），如 "1:1,3:4,16:9" */
  ratios: string
  /** 支持的分辨率档位，如 "1K,2K,4K" */
  tiers: string
  /** 合法的比例×档位组合，如 "1:1@1K,1:1@2K,3:4@1K"（仅 IMAGE 且已声明 sizes） */
  sizePairs?: string
  /** 参考图支持形态：text / single / multi（取 modes 里最强的） */
  ref: string
  /**
   * 视频清晰度档（仅 capability='video' 有意义），如 "480P,768P,2K"。
   *
   * 为什么必须给 planner：视频上游的档位是**枚举**且各家不同
   * 就会编一个不存在的档位 → 提交前被 validateVideoParams 拦下，用户白等一轮。
   */
  resolutions?: string
  /** 视频可选时长（秒），如 "5,10" 或 "4-15"（仅 capability='video'） */
  durations?: string
}

/** planner 菜单输入：模型行（Prisma ModelConfig 的最小面） */
export interface PlannerModelRow {
  id: string
  name: string
  type: string
  costPoints: number
  isFree: boolean
  metadata: unknown
}

/** metadata 里挑字段的安全读取（ImageModelMetadata 实际是 Record<string,unknown>） */
function readImageMeta(metadata: unknown): { sizes: string[]; tierCost: Record<string, number> } {
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
  const sizes = Array.isArray(m.sizes) ? (m.sizes as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const tc = (m.tierCost1K != null || m.tierCost2K != null || m.tierCost4K != null)
    ? {
        '1K': typeof m.tierCost1K === 'number' ? m.tierCost1K : undefined,
        '2K': typeof m.tierCost2K === 'number' ? m.tierCost2K : undefined,
        '4K': typeof m.tierCost4K === 'number' ? m.tierCost4K : undefined,
      } as Record<string, number | undefined>
    : {}
  return { sizes, tierCost: tc as Record<string, number> }
}

const REF_RANK: Record<string, string> = { text: 'text', singleImage: 'single', multiReference: 'multi' }

/**
 * 组装规划器的可用模型菜单。
 *
 * 过滤规则：
 * - metadata.kind === 'ocr' 的模型**不进菜单**（OCR 是系统内部感知能力，
 *   不是用户可交付能力；曾经因为它 capability=vision 而被误当通用视觉模型）
 * - IMAGE 模型若没有声明 sizes，ratios/tiers 置空串（planner 会看到「未声明」，
 *   与工具面板的展示口径一致，避免编造）
 */
/** 偏好行输入（与 AgentPreferencesShape 对齐的最小面） */
export interface PrefRow {
  imageModelId?: string | null
  videoModelId?: string | null
  audioModelId?: string | null
  imageRatio?: string | null
  imageTier?: string | null
  /** 视频偏好（2026-10-26）：与图片三项并列，先把模型说清楚，再说规格 */
  videoRatio?: string | null
  videoResolution?: string | null
  videoDuration?: number | null
}

/**
 * 把用户全局偏好翻译成 planner 可读的中文串。
 *
 * 为什么不传裸 modelId：cuid 对 LLM 无意义，planner 大概率忽略 →
 * 退回追问用户，用户设的全局偏好等于白设。
 *
 * inactiveNames：id → 名称映射（含停用标注）。偏好指向的模型若已停用，
 * 名字会带「（已停用，需重新确认）」后缀，提示 planner 该重新确认而非硬用。
 */
export function formatUserPreferencesText(
  prefs: PrefRow | null | undefined,
  modelNameOf: (id: string | null | undefined) => string | null,
): string {
  if (!prefs) return ''
  const parts: string[] = []
  const img = modelNameOf(prefs.imageModelId)
  if (img) parts.push(`图片模型：${img}`)
  if (prefs.imageRatio) parts.push(`图片比例：${prefs.imageRatio}`)
  if (prefs.imageTier) parts.push(`图片档位：${prefs.imageTier}`)
  const vid = modelNameOf(prefs.videoModelId)
  if (vid) parts.push(`视频模型：${vid}`)
  // 视频规格只在**指定了视频模型**时才有意义 —— 没模型时这些值对应哪个模型的约束无从判断，
  // 硬塞给 planner 反而会诱导它编一个「看起来合理但上游不支持」的组合。
  if (vid) {
    if (prefs.videoRatio) parts.push(`视频比例：${prefs.videoRatio}`)
    if (prefs.videoResolution) parts.push(`视频分辨率：${prefs.videoResolution}`)
    if (prefs.videoDuration) parts.push(`视频时长：${prefs.videoDuration} 秒`)
  }
  const aud = modelNameOf(prefs.audioModelId)
  if (aud) parts.push(`音频模型：${aud}`)
  if (parts.length === 0) return ''
  return `用户全局偏好（用户未在本轮明确指定相关项时采用；与本轮指定冲突时以本轮为准）：${parts.join('；')}`
}

/**
 * 用户手填的长期记忆 / 自我描述 → 一段可注入的文本。
 *
 * 与 formatUserPreferencesText 分开是**刻意的**：
 *   偏好 = 用哪个模型/比例（机器参数，缺失可由代码兜底）
 *   记忆 = 用户是谁、做什么业务、什么风格（人的知识，无法推断）
 * 混在一句里会让模型把两者当成同一类事实，也难单独调试。
 *
 * 注入位置放在「偏好」之后、「可用模型」之前 —— 先交代是谁，再给工具清单。
 */
export function formatUserMemoryText(memory: string | null | undefined): string {
  const t = (memory || '').trim()
  if (!t) return ''
  return [
    '用户自述（长期有效，用于理解他的业务与偏好；与本轮要求冲突时以本轮为准）：',
    t,
  ].join('\n')
}

export function buildModelBrief(rows: PlannerModelRow[]): PlannerModelBrief[] {
  return rows
    .filter((m) => {
      const meta = (m.metadata && typeof m.metadata === 'object' ? m.metadata : {}) as Record<string, unknown>
      return meta.kind !== 'ocr'
    })
    .map((m) => {
      const cap = m.type.toLowerCase()
      const meta = (m.metadata && typeof m.metadata === 'object' ? m.metadata : {}) as Record<string, unknown>
      const { sizes, tierCost } = readImageMeta(m.metadata)
      const imageCap = getImageCapabilities({ metadata: meta })

      // 比例与档位（仅 IMAGE 有意义）
      const ratioSet = new Set<string>()
      const tierSet = new Set<string>()
      const pairSet = new Set<string>()
      for (const entry of sizes) {
        const p = decodeSize(entry)
        if (!p) continue
        ratioSet.add(p.ratio)
        if (p.tier) {
          tierSet.add(p.tier)
          pairSet.add(`${p.ratio}@${p.tier}`)
        }
      }
      // 视频比例来自 metadata.video.constraints.ratios，不是图片的 sizes。
      // 之前只读 sizes → 视频模型 ratios 永远是空串，planner 只能猜比例，
      // 与「参数必须来自模型真实能力」的约束直接矛盾。
      if (cap === 'video') {
        const declared = getVideoCapabilities({ metadata: meta }).ratios
        // 未声明比例时与 validateVideoParams 同口径：视为支持全部常用比例。
        for (const r of declared.length > 0 ? declared : DEFAULT_VIDEO_RATIOS) ratioSet.add(r)
      }
      const ratios = [...ratioSet].join(',')
      const tiers = [...tierSet].join(',')

      // 价格串：有档位价用档位价（1K/2K/4K 顺序），否则退回统一价
      let cost = ''
      if (cap === 'image') {
        if (Object.keys(tierCost).length > 0) {
          const parts = ['1K', '2K', '4K']
            .map((t) => (tierCost[t] != null ? String(tierCost[t]) : null))
            .filter((x): x is string => x != null)
          cost = parts.join('/')
        }
        if (!cost) cost = String(m.costPoints ?? 0)
      } else if (cap === 'video') {
        // 视频计价单位是豆（与积分不同币种），planner 必须知道，否则会按积分口径估算
        // 档位定价的模型：用「首个支持的档位」当基准（不传 resolution 会算成 0，看着像免费）
        const vcForPrice = getVideoCapabilities({ metadata: meta })
        const defaultRes = vcForPrice.resolutions.length > 0
          ? normalizeVideoResolution(vcForPrice.resolutions[0])
          : undefined
        const beans = resolveVideoBeans(
          { costPoints: m.costPoints ?? 0, videoCost: null, metadata: meta },
          { durationSec: 5, resolution: defaultRes },
        )
        cost = beans > 0 ? `${beans}豆/5秒` : String(m.costPoints ?? 0)
      } else {
        cost = String(m.costPoints ?? 0)
      }

      // 参考图形态（video/image 通用 modes；取最强）
      const modes = Array.isArray(meta.modes) ? (meta.modes as unknown[]).filter((x): x is string => typeof x === 'string') : []
      const ref = modes.includes('multiReference') ? 'multi' : modes.includes('singleImage') ? 'single' : modes.includes('text') ? 'text' : ''

      // 视频能力（档位/时长）：让 planner 只能从模型真实支持的项里选。
      // 用与使用端同一个 getVideoCapabilities，避免两处口径漂移。
      let resolutions = ''
      let durations = ''
      if (cap === 'video') {
        const vc = getVideoCapabilities({ metadata: meta })
        resolutions = vc.resolutions.length > 0
          ? vc.resolutions.map((r) => normalizeVideoResolution(r)).join(',')
          : DEFAULT_VIDEO_RESOLUTIONS.join(',')
        if (vc.fixedDuration != null) durations = String(vc.fixedDuration)
        else if (vc.durations.length > 0) durations = [...vc.durations].sort((a, b) => a - b).join(',')
        else if (vc.minDuration != null && vc.maxDuration != null) durations = `${vc.minDuration}-${vc.maxDuration}`
        else durations = '5,10,15'
      }

      return {
        id: m.id,
        name: m.name,
        capability: cap,
        free: m.isFree || !(m.costPoints > 0),
        cost,
        ratios,
        tiers,
        ...(cap === 'image' && imageCap.declared && pairSet.size > 0
          ? { sizePairs: [...pairSet].join(',') }
          : {}),
        ref,
        ...(cap === 'video' ? { resolutions, durations } : {}),
      }
    })
}

/**
 * Agent 规划调用的「思考强度」策略。
 *
 * 背景（生产实测，2026-10-01）：思考模型（metadata.think=true）的 reasoning 与正文
 * **共用输出预算**。实测同一个 glm-5.3-flash 在真实 6 方向套图工具调用场景下：
 *   默认 effort → 推理 1272 token、耗时 40.3s
 *   effort=low → 推理   19 token、耗时 16.7s，6 个 tool_call 一个不少
 * 而生产失败日志里出现过「只输出推理过程（14256 字）≈ 4700 token 未产出动作」——
 * 推理吃满 max_tokens，动作就没机会产出。这就是用户看到的「思考很久然后失败」。
 *
 * 所以对 Agent 这种「按约束产出结构化动作」的任务，压低思考是纯收益：
 * 更快、更省、结果等价。只有显式声明 think:true 的模型才下发（非思考模型传了会被拒）。
 */
export function resolveAgentReasoningEffort(
  metadata: unknown,
  override?: 'none' | 'low' | 'medium' | 'high',
): 'none' | 'low' | 'medium' | 'high' | undefined {
  if (override) return override
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
  // 只有思考模型才下发 reasoning_effort：非思考模型不认识该字段，可能直接报 400
  return meta.think === true ? 'low' : undefined
}

export function buildAgentPlannerSystemPrompt(): string {
  return `你是${ORG.name}创作 Agent。

【你是谁】把用户需求变成可执行的创作任务，并调用平台的生图/视频/音频/文本模型产出结果。

【你能做什么】
- 生图：文本生图（无参考图）与图生图（有上传图时必须带上原图）。
- 文本：文案/脚本/提示词方案。视频/音频：按已启用模型调用。
- 可用模型只看 availableModels，不要编造。
- 按 deliverable.type 的 capability 字段精确匹配：image 任务只选 capability:"image" 的模型；vision/text 模型是**对话模型**（看图说话/写文案），**不能出图**，选了上游必拒绝。image 模型再按 ratios/tiers 核对比例档位。

【怎么调用】
- 底层与画布生图节点、工具箱操作面板完全一致：同模型、同比例档位映射、同排队与计费。
- 每个 image deliverable 必须填 model 与 ratio；count 为张数。
- deliverable.model 必须填 availableModels 里该项的 **id 字段原值**（形如 cmt... 的 cuid），**不要填 name**。填成 name 会被执行层按名称兜底，但不保证唯一，属于不规范输出。
- 选模型前先看 availableModels 里的 ratios/tiers/sizePairs（该模型支持的画幅、档位与合法组合）与 cost（档位单价）：不要给模型选它 ratios 里没有的比例，不要选 sizePairs 里不存在的「比例@档位」组合，不要在用户没要求高清时默认 4K。免费模型 free=true 可优先提示用户。
- 有参考图时必须走图生图：把 referencedAssets 里的图片编号填进对应 deliverable.assetIds（如 referencedAssets 为"图片1/图片2"，就写 \"assetIds\":[\"图片1\",\"图片2\"]），原图会随提示词一起发给生图模型。**image 与 video 交付物都一样**。凡是用户上传了产品图/参考图却让 assetIds 留空，都算规划错误。
- 有参考图时**不要用文字复述图里已有的颜色/材质/外观细节**（如"粉色亮片鞋面""银色鞋带"）。模型能直接看图，复述反而会与实物不一致，且会让画面被文字描述带偏。提示词只写构图、场景、风格、光线。
- **视频 deliverable**：除了 model/ratio/seconds，还要填 resolutions 里支持的档位（写 "resolution" 字段，如 "768P"），以及 durations 里支持的秒数（写 "seconds"）。不要编造模型没声明的档位/时长——提交前会被拦下、用户白等一轮。

【何时才执行】
- 参数齐全才规划 deliverable 并执行。参数优先级：本轮用户明确指定 > userPreferencesText（用户全局偏好，可读串）> 缺则追问（reply 里列 A/B/C 选项）。
- 缺参时：intent 仍为 generation，deliverables=[]，在 reply 里用简短选项（A/B/C）列出缺失项并等待补充，不要生成占位图。
- 闲聊/问答 → intent=conversation，deliverables=[]。

【输出】
只输出一个 JSON 对象，无 markdown 围栏、无多余文字，字符串内不要出现未转义的换行与双引号：
{"intent":"generation","objective":"...","reply":"...","decisions":[{"label":"...","value":"...","reason":"..."}],"foundation":{"complexity":"simple|complex","brief":{"objective":"...","audience":"...","usage":"...","coreMessage":"...","constraints":["..."],"referenceStrategy":"..."},"direction":{"summary":"...","style":"...","composition":"...","colors":["..."],"lighting":"...","keywords":["..."],"avoid":["..."]}},"deliverables":[{"id":"task-0","title":"...","type":"text|image|video|audio","model":"模型id","prompt":"...","count":1,"ratio":"3:4","quality":"2K","resolution":"768P","seconds":5,"dependencies":[],"assetIds":[]}]}
assetIds 说明：引用第 N 张上传图就写 "图片N"（无参考图时才留空数组）。`
}
