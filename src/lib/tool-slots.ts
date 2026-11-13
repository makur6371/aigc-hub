// ===== 工具系统：Slot 识别引擎 =====
// 纯函数：画布快照（nodes + connections）→ 面板控件清单（Slot[]）
// 设计文档：docs/TOOL_SYSTEM_DESIGN.md §2
// 零编程概念：Slot 面向「素材口 / 文字口 / 风格组 / 模型 / 规格档 / 数量 / 结果区」

import { getNodeDefinition, type NodeDefinition } from './canvas-nodes'

// ---------- 数据结构 ----------

export interface ToolNodeSnapshot {
  id: string
  type: string
  label?: string
  inputs?: Record<string, unknown>
  [k: string]: unknown
}

export interface ToolConnectionSnapshot {
  id?: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  index?: number
}

/** 面板控件（Slot）类型 */
export type ToolSlotType = 'upload' | 'text' | 'choice' | 'model' | 'ratio' | 'number' | 'result'
export interface ToolSlot {
  id: string
  type: ToolSlotType
  /** 面板显示名（作者向导可改名） */
  label: string
  description?: string
  /**
   * 是否必填 —— **只由识别逻辑（`analyzeToolSlots`）决定，作者不能改**。
   *
   * 这条注释很重要（Q-411）：`reconcileParamSlots` 重新识别时只继承作者的
   * `label` / `hidden`，**不继承 `required`**。如果你的第一反应是「那是个 bug」，
   * 先看这里：`required` 是**由节点拓扑推导**出来的（比如某个图片生成节点没有
   * 上游连线，就必须由用户上传一张），作者手改一个 `true` 并不能让那个节点
   * 真的变成必填 —— 它下次重新识别就会被覆盖回推导值。
   *
   * 所以：**不要**在向导里给作者提供「必填」开关（现在也没有），
   * **也不要**把 `required` 当作可持久化的作者意图来读。
   * 真要支持「作者自定义必填」，得先把它加进 `reconcileParamSlots` 的继承表，
   * 否则又是一个「存了但静默失效」的字段。
   */
  required?: boolean
  /** 该 Slot 控制哪些节点/端口的写入计划：执行时按此替换 inputs */
  targets: ToolSlotTarget[]
  // ---- upload ----
  /** 素材类型（图片/音频/视频/文字），单素材口固定一个 */
  accept?: Array<'image' | 'video' | 'audio' | 'text'>
  /** 是否允许多张（批量上传口） */
  multiple?: boolean
  // ---- choice（风格组）----
  /** 每个选项 = 一个并行变体节点（名称取节点标题，配方按快照连线走） */
  options?: ToolChoiceOption[]
  /** 是否单选（默认多选，多选=按分支循环出 N 份结果） */
  single?: boolean
  /**
   * 本控件的可选项依赖另一个槽的当前值（前端筛选，不影响执行）。
   *
   * 用途：多平台套图里，「出图方向」的可选项要随「平台」变化 ——
   * OZON 专属方向在 Amazon 下不该出现。用这个字段声明依赖，
   * 前端按 values[slotId] 过滤 options.tags 即可。
   *
   * 为什么不生成不同的工作流：方向之间有大量通用项，按平台复制会让节点数爆炸；
   * 执行层只认「用户勾了哪些 nodeId」，前端隐藏未选平台的项等价且零成本。
   */
  dependsOn?: {
    /** 依赖的槽 id（如平台选择槽） */
    slotId: string
    /** 按 options.tags 过滤：只保留 tags 含当前值（或含 '*'）的选项 */
    filterByTag?: boolean
    /** 依赖值为空时是否显示全部选项（默认 true：避免没选平台时列表空掉） */
    showAllWhenEmpty?: boolean
  }
  // ---- model ----
  /** 模型类型过滤（TEXT/VISION/IMAGE/VIDEO/AUDIO），用于前端拉对应模型列表 */
  modelType?: 'TEXT' | 'VISION' | 'IMAGE' | 'VIDEO' | 'AUDIO'
  /**
   * 视频上传槽的「生成方式」归属（2026-11-08）。
   *
   * 为什么不能靠端口推断：合并版视频生成工具里，首帧/尾帧槽与多图参考槽
   * 都写在 image 端口上（首帧经 upload 节点转发到 v1.firstFrame），端口区分不开。
   * 声明后：面板只在所选模型的 modes 含该方式、且用户选了它时才显示这个槽。
   * 未声明 → 沿用「素材口跟随模型能力」的旧逻辑（单形态工具不受影响）。
   */
  videoModeOnly?: 'text' | 'multiReference' | 'firstLastFrame'
  // ---- ratio ----
  /** 可选比例+档位由前端固定档位表渲染，这里存默认值 */
  defaultRatio?: string // 如 '1:1'
  defaultTier?: '1K' | '2K' | '3K'
  // ---- text ----
  /** 预设候选值：面板渲染成「下拉 + 可自定义」而不是纯文本框（如文案语言、平台） */
  presets?: string[]
  // ---- number（倍增器，P2）----
  multipliers?: number[]
  // ---- 通用 ----
  hidden?: boolean // 作者选择不在面板展示（用快照默认值）
  /** 确认状态：confirmed=生效；suggested=识别引擎疑似、待作者在发布向导确认（旧数据无此字段视为 confirmed） */
  status?: 'confirmed' | 'suggested'
}

/** Slot 写入目标：执行时把面板值写到 {nodeId}.inputs.{port} */
export interface ToolSlotTarget {
  nodeId: string
  port: string
}

export interface ToolChoiceOption {
  /** 选项名（默认取变体节点标题） */
  label: string
  /** 变体节点 id（执行时按选中项剪枝/复制分支） */
  nodeId: string
  /** 是否含 LLM 智能润色（变体链路上有 llm-chat） */
  aiPolish?: boolean
  /**
   * 归属标签（如平台名）。配合 slot.dependsOn 做前端筛选：
   * 面板只展示 tags 命中当前平台（或含 '*')的选项。
   *
   * 执行层完全不看这个字段——被隐藏的选项只要没被选中，就不会进 buildRuns。
   */
  tags?: string[]
}

// ---------- 内部工具 ----------

/** 电商文案语言预设（面板下拉候选，仍允许自定义） */
export const LANGUAGE_PRESETS = [
  '中文', 'English', 'Русский', '日本語', '한국어',
  'Deutsch', 'Français', 'Español', 'Português', 'Italiano',
  'العربية', 'ไทย', 'Tiếng Việt',
]

const GENERATIVE_TYPES = new Set([
  'llm-chat', 'image-generate', 'nine-grid-loop', 'video-generate', 'audio-generate', 'music-generate',
  'tts-generate', 'sfx-generate', 'voice-isolate', 'transcribe', 'ocr',
])

/** 走同一个生图模型 / 规格槽的节点类型（九宫格循环帧只是提示词形态不同） */
const IMAGE_GENERATE_TYPES = new Set(['image-generate', 'nine-grid-loop'])
function isImageGenerateType(type: string): boolean {
  return IMAGE_GENERATE_TYPES.has(type)
}

/** 会产出媒体结果的节点 → result 展示区来源 */
const RESULT_PRODUCERS: Record<string, string[]> = {
  'image-generate': ['imageUrl'],
  'nine-grid-loop': ['imageUrl'],
  'grid9-to-gif': ['gifUrl'],
  'image-crop': ['images'],
  'video-generate': ['videoUrl'],
  'audio-generate': ['audioUrl'],
  'music-generate': ['audioUrl'],
  'tts-generate': ['audioUrl'],
  'sfx-generate': ['audioUrl', 'audioUrls'],
  'voice-isolate': ['audioUrl'],
}

function def(type: string): NodeDefinition | undefined {
  return getNodeDefinition(type)
}

/** 节点显示名 */
function nodeLabel(node: ToolNodeSnapshot): string {
  return String(node.label || def(node.type)?.label || node.type)
}

/**
 * 并行变体组判定（设计文档 §2 choice 行 / §3）：
 * 一组同类型节点（llm-chat 或 image-generate），满足：
 * 1. 并列——组内任意两个节点互不为上下游（串行不算并列）
 * 2. 下游一致——它们的输出最终流向同一个下游节点；或均为工作流终点（无下游）
 * 上游不要求一致：同样提示词结构但各自接不同上传口（如九宫格多素材）也是并列变体，
 * 作者可在发布向导确认/拆散。
 * 三种配方形态合法（提示词直连 / LLM 适配 / 生图自带提示词），识别只看并行结构。
 */
export function findVariantGroups(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
): ToolNodeSnapshot[][] {
  const candidateTypes = ['llm-chat', 'image-generate', 'nine-grid-loop']
  const candidates = nodes.filter((n) => candidateTypes.includes(n.type))
  if (candidates.length < 2) return []

  // 下游可达集（沿连线向下，包含汇聚终点）
  const downStream = (nodeId: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [nodeId]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of connections) {
        if (c.sourceNodeId === cur && !seen.has(c.targetNodeId)) {
          seen.add(c.targetNodeId)
          stack.push(c.targetNodeId)
        }
      }
    }
    return seen
  }

  const downCache = new Map<string, Set<string>>()
  const down = (id: string) => {
    if (!downCache.has(id)) downCache.set(id, downStream(id))
    return downCache.get(id)!
  }

  // 判定两个候选节点是否属于同一变体组：并列（互不为上下游）且下游有交集（含同为终点）
  const isPairVariant = (a: ToolNodeSnapshot, b: ToolNodeSnapshot): boolean => {
    const da = down(a.id)
    const db = down(b.id)
    if (da.has(b.id) || db.has(a.id)) return false // 串行
    if (da.size === 0 && db.size === 0) return true // 均为并列终点
    return [...da].some((x) => db.has(x))
  }

  // 按类型做传递闭包分组（A~B 且 B~C 则同组），再剔除混入串行关系的坏组
  const groups = new Map<string, ToolNodeSnapshot[]>()
  for (const n of candidates) {
    if (!groups.has(n.type)) groups.set(n.type, [])
    groups.get(n.type)!.push(n)
  }

  const result: ToolNodeSnapshot[][] = []
  for (const sameType of groups.values()) {
    if (sameType.length < 2) continue
    // 并查集：满足 pair 判定就合并
    const parent = sameType.map((_, i) => i)
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
    for (let i = 0; i < sameType.length; i++) {
      for (let j = i + 1; j < sameType.length; j++) {
        if (isPairVariant(sameType[i], sameType[j])) {
          parent[find(i)] = find(j)
        }
      }
    }
    const buckets = new Map<number, ToolNodeSnapshot[]>()
    sameType.forEach((n, i) => {
      const r = find(i)
      if (!buckets.has(r)) buckets.set(r, [])
      buckets.get(r)!.push(n)
    })
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      // 组内必须整体并列（传递合并可能串入 A→C 关系），否则剔除
      const parallel = bucket.every((a, i) =>
        bucket.every((b, j) => i === j || !down(a.id).has(b.id)),
      )
      if (parallel) result.push(bucket)
    }
  }
  return result
}

/**
 * 图片上传口识别（统一「多图整传」语义）：
 * - 无 image-upload → 无上传口
 * - 单个 image-upload → 单图口；若其直接下游 ≥2 个且都是生成类节点（一条素材喂多条支路），升级为多张口
 * - ≥2 个并列 image-upload → 合并为一个多张口，targets 覆盖全部上传节点，上传数组整传给每条下游
 * 不在节点层区分「多张素材」与「不同功能的图」：多图如何进模型由 adapter 负责适配（如写入 images 字段）。
 */
function buildImageUploadSlot(
  uploadNodes: ToolNodeSnapshot[],
  allNodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
): ToolSlot | null {
  if (uploadNodes.length === 0) return null
  if (uploadNodes.length === 1) {
    const node = uploadNodes[0]
    const downstream = new Set(
      connections.filter((c) => c.sourceNodeId === node.id).map((c) => c.targetNodeId),
    )
    const allGenerative = [...downstream].every((id) => {
      const n = allNodes.find((x) => x.id === id)
      return n ? GENERATIVE_TYPES.has(n.type) : false
    })
    const fanOut = downstream.size >= 2 && allGenerative
    return {
      id: `upload:${node.id}`,
      type: 'upload',
      label: nodeLabel(node),
      description: fanOut ? '上传一张或多张图片，会一起传给后续每一步' : '上传一张图片作为素材',
      required: true,
      accept: ['image'],
      multiple: fanOut,
      status: 'confirmed',
      targets: [{ nodeId: node.id, port: 'image' }],
    }
  }
  const first = uploadNodes[0]
  return {
    id: `upload:${first.id}`,
    type: 'upload',
    label: `${nodeLabel(first)}（可多张）`,
    description: '上传一张或多张图片，会一起传给后续步骤',
    required: true,
    accept: ['image'],
    multiple: true,
    status: 'confirmed',
    targets: uploadNodes.map((n) => ({ nodeId: n.id, port: 'image' })),
  }
}

/** 变体链路上是否有 LLM（标「含智能润色」） */
function hasLlmUpstream(nodeId: string, nodes: ToolNodeSnapshot[], connections: ToolConnectionSnapshot[]): boolean {
  const types = new Map(nodes.map((n) => [n.id, n.type]))
  const stack = [nodeId]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    if (types.get(cur) === 'llm-chat') return true
    for (const c of connections) {
      if (c.targetNodeId === cur) stack.push(c.sourceNodeId)
    }
  }
  return false
}

/** 判断节点端口是否已有可运行值；空对象/空数组也视为空 */
function portHasValue(node: ToolNodeSnapshot, port: string): boolean {
  const value = node.inputs?.[port]
  if (value === null || value === undefined || value === '') return false
  if (typeof value !== 'object') return true
  if (Array.isArray(value)) return value.length > 0
  return Object.values(value as Record<string, unknown>).some((item) => item !== null && item !== undefined && item !== '')
}

// ---------- 主入口 ----------

export interface AnalyzeSlotsResult {
  slots: ToolSlot[]
  /** 风格组变体节点 id 集合（供发布向导高亮） */
  variantNodeIds: string[]
  /** 疑似重复动作建议（不混入 slots；发布向导逐步确认后才生效） */
  suggestions: SlotSuggestion[]
  /** 工作流校验问题（警告/错误） */
  validationIssues: ValidationIssue[]
  /** 整体置信度评分 0-100（基于识别质量和完整性） */
  confidence: number
}

/** 工作流校验问题 */
export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  nodeIds: string[]
  category: 'structure' | 'params' | 'connectivity'
}

/** 一条「疑似重复动作」建议：向导确认后并入 slots（status 置 confirmed），拒绝则丢弃 */
export interface SlotSuggestion {
  kind: 'variant-group'
  /** 组装好的建议 slot（status:'suggested'） */
  slot: ToolSlot
  /** 涉及节点 id（向导展示/高亮） */
  nodeIds: string[]
  /** 给作者看的判定理由文案 */
  reason: string
}

/**
 * 识别画布快照 → Slot[]。
 * 规则（设计文档 §2）：
 * - image-upload / image-upload-batch / audio-upload → upload
 * - text-input → text
 * - llm-chat / image-generate / video-generate / 音频类 的 inputs.model → model
 * - image-generate 的 width/height → ratio；video-generate 的 aspectRatio → ratio
 * - 并行变体组 → choice（风格组）
 * - 所有产出节点 → result（一个展示区）
 */
export function analyzeToolSlots(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
): AnalyzeSlotsResult {
  const slots: ToolSlot[] = []
  const suggestions: SlotSuggestion[] = []
  const validationIssues: ValidationIssue[] = []
  const variantGroups = findVariantGroups(nodes, connections)
  const variantNodeIds = new Set(variantGroups.flat().map((n) => n.id))
  const variantRepresentativeIds = new Map(variantGroups.flatMap((group) => group.map((n) => [n.id, group[0].id] as const)))
  const similarGroups = findSimilarActionGroups(nodes, connections)
  const similarGroupById = new Map<string, ToolNodeSnapshot[]>()
  for (const group of similarGroups) {
    if (group.length < 2 || group.some((node) => variantNodeIds.has(node.id))) continue
    for (const node of group) similarGroupById.set(node.id, group)
  }
  const modelSlotNodeIds = new Set<string>()
  const ratioSlotNodeIds = new Set<string>()
  const incomingPromptNodeIds = new Set(
    connections.filter((c) => c.targetPort === 'prompt').map((c) => c.targetNodeId),
  )

  // ---------- upload / text ----------
  // 图片上传口统一识别为「可上传一张或多张」：并列的多个 image-upload 节点合为一个多图口，
  // 上传的图片整体（数组）传给每条下游支路；不在节点层区分「多张素材」与「不同功能的图」，
  // 具体适配（写入 images 字段等）交给模型 adapter 完成。
  const singleUploadNodes: ToolNodeSnapshot[] = nodes.filter((n) => n.type === 'image-upload')
  const imageUploadSlot = buildImageUploadSlot(singleUploadNodes, nodes, connections)
  let imageUploadPushed = false
  for (const node of nodes) {
    if (node.type === 'image-upload') {
      if (imageUploadSlot && !imageUploadPushed) { slots.push(imageUploadSlot); imageUploadPushed = true }
      continue
    } else if (node.type === 'image-upload-batch') {
      slots.push({
        id: `upload:${node.id}`,
        type: 'upload',
        label: nodeLabel(node),
        description: '上传多张图片作为素材',
        required: false,
        accept: ['image'],
        multiple: true,
        status: 'confirmed',
        targets: [{ nodeId: node.id, port: 'images' }],
      })
    } else if (node.type === 'audio-upload') {
      slots.push({
        id: `upload:${node.id}`,
        type: 'upload',
        label: nodeLabel(node),
        description: '上传或录制一段音频',
        required: true,
        accept: ['audio'],
        multiple: false,
        status: 'confirmed',
        targets: [{ nodeId: node.id, port: 'audio' }],
      })
    } else if (node.type === 'video-upload') {
      slots.push({
        id: `upload:${node.id}`,
        type: 'upload',
        label: nodeLabel(node),
        description: '上传一段视频作为素材',
        required: false,
        accept: ['video'],
        multiple: false,
        status: 'confirmed',
        targets: [{ nodeId: node.id, port: 'video' }],
      })
    } else if (node.type === 'text-input') {
      // 「文案语言」这类文本口给一组预设候选，面板渲染成下拉（可自定义），避免手打出错别字。
      // 判定：节点标题或内容里出现「语言 / language」。
      const label = nodeLabel(node)
      const content = String(node.inputs?.content ?? '')
      const isLanguage = /语言|language|lang/i.test(label) || /^(中文|英文|俄语|日语|韩语|English|Russian|Japanese|Korean)$/i.test(content.trim())
      slots.push({
        id: `text:${node.id}`,
        type: 'text',
        label,
        description: isLanguage ? '选择图片上营销文案使用的语言' : '输入文字内容',
        required: true,
        status: 'confirmed',
        ...(isLanguage ? { presets: LANGUAGE_PRESETS } : {}),
        targets: [{ nodeId: node.id, port: 'content' }],
      })
    } else if (node.type === 'llm-chat') {
      // LLM 节点：系统提示词出 text 槽（用户可在面板调整人设/规则），跳过变体组节点（跟风格走）
      if (!variantNodeIds.has(node.id) && node.inputs?.systemPrompt) {
        slots.push({
          id: `sysprompt:${node.id}`,
          type: 'text',
          label: `${nodeLabel(node)} · 系统提示词`,
          description: '这一步 AI 的角色设定/规则（高级）',
          required: false,
          hidden: String(node.inputs.systemPrompt).length < 12,
          status: 'confirmed',
          targets: [{ nodeId: node.id, port: 'systemPrompt' }],
        })
      }
    } else if (node.type === 'nine-grid-loop') {
      // 九宫格循环帧只暴露一个「分镜脚本」文本口（【角色】【场景】【动作】【画风】
      // 四个小节写在一个框里），执行端由 nine-grid-loop.ts 解析后构造提示词。
      const connectedPorts = new Set(
        connections.filter((c) => c.targetNodeId === node.id).map((c) => c.targetPort),
      )
      if (!connectedPorts.has('script')) {
        slots.push({
          id: `text:${node.id}:script`,
          type: 'text',
          label: '分镜脚本',
          description: '一个文本框写完：【角色】外观 / 【场景】镜头 / 【动作】9或16行 / 【画风】（可省略）；也可只写一段创作描述',
          required: true,
          status: 'confirmed',
          targets: [{ nodeId: node.id, port: 'script' }],
        })
      }
    } else if (node.type === 'grid9-to-gif') {
      // 九宫格转 GIF 的三个高频参数：帧间隔 / 播放模式 / 帧选择。
      // 裁格线、最长边、背景色留在快照里（默认值足够用），避免工具面板变成参数表。
      const textPorts: Array<{
        port: string
        label: string
        description: string
        required: boolean
        presets?: string[]
      }> = [
        { port: 'delayMs', label: '帧间隔(毫秒)', description: '每帧停留时间，建议 80-300ms', required: false },
        {
          port: 'mode',
          label: '播放模式',
          description: '正序循环，或往返乒乓（1→9→1）',
          required: false,
          presets: ['正序循环', '往返乒乓'],
        },
        {
          port: 'frames',
          label: '帧选择',
          description: '1-9、1,3,5、1-4,9；填写顺序即播放顺序',
          required: false,
        },
      ]
      const connectedPorts = new Set(
        connections.filter((c) => c.targetNodeId === node.id).map((c) => c.targetPort),
      )
      for (const item of textPorts) {
        if (connectedPorts.has(item.port)) continue
        slots.push({
          id: `text:${node.id}:${item.port}`,
          type: 'text',
          label: item.label,
          description: item.description,
          required: item.required,
          status: 'confirmed',
          ...(item.presets ? { presets: item.presets } : {}),
          targets: [{ nodeId: node.id, port: item.port }],
        })
      }
    }
  }


  // ---------- choice（风格组，跳过已被组吸收的节点） ----------
  variantGroups.forEach((group, gi) => {
    slots.push({
      id: `choice:group${gi}`,
      type: 'choice',
      label: gi === 0 ? '风格' : `风格 ${gi + 1}`,
      description: '选择一个或多个风格，每个风格各出一批结果',
      options: group.map((n) => ({
        label: nodeLabel(n),
        nodeId: n.id,
        aiPolish: hasLlmUpstream(n.id, nodes, connections) || n.type === 'llm-chat',
      })),
      single: false,
      status: 'confirmed',
      targets: [],
    })
  })

  // ---------- model / ratio（生成类节点；变体组统一暴露同一个模型/规格控件） ----------
  for (const node of nodes) {
    const d = def(node.type)
    if (!d || !GENERATIVE_TYPES.has(node.type)) continue
    if (modelSlotNodeIds.has(node.id) && ratioSlotNodeIds.has(node.id)) continue

    const variantGroup = variantNodeIds.has(node.id)
      ? variantGroups.find((group) => group.some((candidate) => candidate.id === node.id))
      : undefined
    const similarGroup = similarGroupById.get(node.id)
    const parameterGroup = variantGroup ?? similarGroup
    const inspectNode = variantGroup?.[0] ?? node
    const inspectDef = def(inspectNode.type) ?? d
    if (!incomingPromptNodeIds.has(node.id) && !portHasValue(inspectNode, 'prompt') && inspectDef.inputs.prompt) {
      slots.push({
        id: `prompt:${variantGroup?.[0].id ?? node.id}`,
        type: 'text',
        label: isImageGenerateType(node.type) ? '画面描述' : `${nodeLabel(node)} · 描述`,
        description: '描述这一步要生成/处理的内容',
        required: true,
        status: 'confirmed',
        targets: (variantGroup ?? [node]).map((groupNode) => ({ nodeId: groupNode.id, port: 'prompt' })),
      })
    }

    const modelGroup = parameterGroup?.filter((candidate) => candidate.type === node.type) ?? [node]
    const canShareModel = modelGroup.length > 1 && modelGroup.every((candidate) =>
      JSON.stringify(candidate.inputs?.model ?? null) === JSON.stringify(modelGroup[0].inputs?.model ?? null),
    )
    const modelTargets = canShareModel ? modelGroup : [node]
    if (modelTargets.some((candidate) => modelSlotNodeIds.has(candidate.id))) continue
    const modelPort = inspectNode.inputs && 'model' in inspectNode.inputs
      ? 'model'
      : inspectDef.inputs.model ? 'model' : null
    if (modelPort) {
      const modelType =
        node.type === 'video-generate' ? 'VIDEO'
        : isImageGenerateType(node.type) ? 'IMAGE'
        : ['audio-generate', 'music-generate', 'tts-generate', 'sfx-generate', 'voice-isolate', 'transcribe'].includes(node.type) ? 'AUDIO'
        : 'TEXT'
      slots.push({
        id: `model:${modelTargets[0].id}`,
        type: 'model',
        label: isImageGenerateType(node.type) ? '生图模型' : nodeLabel(node) + ' 模型',
        description: '选择这一步使用的模型',
        modelType,
        // 强制选择：不选模型时后端会按类型兜底取第一个激活模型，
        // 用户以为「没选也能跑」，结果规格/质量按默认参数发出，效果不符还要重跑一次。
        // 标成必填，前端会拦下并提示。
        required: true,
        status: 'confirmed',
        targets: modelTargets.map((groupNode) => ({ nodeId: groupNode.id, port: 'model' })),
      })
      for (const groupNode of modelTargets) modelSlotNodeIds.add(groupNode.id)
    }

    if (isImageGenerateType(node.type)) {
      const ratioGroup = parameterGroup?.filter((candidate) => candidate.type === node.type) ?? [node]
      const canShareRatio = ratioGroup.length > 1 && ratioGroup.every((candidate) =>
        Number(candidate.inputs?.width ?? 0) === Number(ratioGroup[0].inputs?.width ?? 0)
        && Number(candidate.inputs?.height ?? 0) === Number(ratioGroup[0].inputs?.height ?? 0),
      )
      const ratioTargets = canShareRatio ? ratioGroup : [node]
      if (ratioTargets.some((candidate) => ratioSlotNodeIds.has(candidate.id))) continue
      slots.push({
        id: `ratio:${ratioTargets[0].id}`,
        type: 'ratio',
        label: '图片规格',
        description: '选择画面比例和清晰度档位',
        defaultRatio: ratioFromSize(ratioTargets[0].inputs?.width, ratioTargets[0].inputs?.height) ?? '1:1',
        defaultTier: '1K',
        status: 'confirmed',
        targets: ratioTargets.flatMap((groupNode) => [
          { nodeId: groupNode.id, port: 'width' },
          { nodeId: groupNode.id, port: 'height' },
        ]),
      })
      for (const groupNode of ratioTargets) ratioSlotNodeIds.add(groupNode.id)
    } else if (node.type === 'video-generate') {
      const ratioGroup = parameterGroup?.filter((candidate) => candidate.type === node.type) ?? [node]
      const canShareRatio = ratioGroup.length > 1 && ratioGroup.every((candidate) =>
        String(candidate.inputs?.aspectRatio ?? '') === String(ratioGroup[0].inputs?.aspectRatio ?? ''),
      )
      const ratioTargets = canShareRatio ? ratioGroup : [node]
      if (ratioTargets.some((candidate) => ratioSlotNodeIds.has(candidate.id))) continue
      slots.push({
        id: `ratio:${ratioTargets[0].id}`,
        type: 'ratio',
        label: '视频画幅',
        description: '选择视频比例 / 分辨率 / 时长（随所选模型支持项过滤）',
        defaultRatio: String(ratioTargets[0].inputs?.aspectRatio ?? '16:9'),
        status: 'confirmed',
        // 视频槽位同时驱动 aspectRatio + width/height + duration：
        // 选好模型后前端只给该模型支持的比例/分辨率/时长，避免提交后失败。
        targets: ratioTargets.flatMap((groupNode) => [
          { nodeId: groupNode.id, port: 'aspectRatio' },
          { nodeId: groupNode.id, port: 'width' },
          { nodeId: groupNode.id, port: 'height' },
          // 分辨率档位单独下发（上游按枚举档生成/计费，如 768P/2K）：
          { nodeId: groupNode.id, port: 'resolution' },
          { nodeId: groupNode.id, port: 'duration' },
        ]),
      })
      for (const groupNode of ratioTargets) ratioSlotNodeIds.add(groupNode.id)
    }
  }

  // ---------- result（一个展示区，收集所有产出节点） ----------
  const producers = nodes.filter((n) => RESULT_PRODUCERS[n.type])
  if (producers.length) {
    slots.push({
      id: 'result:main',
      type: 'result',
      label: '生成结果',
      description: '本次运行的图片/视频/音频会展示在这里',
      status: 'confirmed',
      targets: producers.map((n) => ({ nodeId: n.id, port: RESULT_PRODUCERS[n.type][0] })),
    })
  }

  // ---------- 疑似重复动作建议（不混入 slots，向导确认后生效） ----------

  // 1) 同构重复节点：同 type + 上游签名一致 + 互不相连，但未达现有 choice 判定口径
  //    （现有判定要求下游汇聚/并列终点；这里把「结构疑似变体」也提示给作者判断）
  const strictGroups = findSimilarActionGroups(nodes, connections)
  const seenSuggestNodes = new Set(variantNodeIds)
  for (const group of strictGroups) {
    if (group.length < 2) continue
    const ids = group.map((n) => n.id)
    if (ids.every((id) => seenSuggestNodes.has(id))) continue
    for (const id of ids) seenSuggestNodes.add(id)
    suggestions.push({
      kind: 'variant-group',
      slot: {
        id: `choice:suggest-${ids[0]}`,
        type: 'choice',
        label: '风格',
        description: '选择一个或多个风格，每个风格各出一批结果',
        options: group.map((n) => ({
          label: nodeLabel(n),
          nodeId: n.id,
          aiPolish: hasLlmUpstream(n.id, nodes, connections) || n.type === 'llm-chat',
        })),
        single: false,
        status: 'suggested',
        targets: [],
      },
      nodeIds: ids,
      reason: `检测到 ${group.length} 个相似的「${nodeLabel(group[0])}」节点，结构相同（同类型、同样的上游输入）`,
    })
  }

  // ---------- 工作流校验 ----------
  validateWorkflow(nodes, connections, slots, validationIssues)

  // ---------- 置信度评分 ----------
  const confidence = calculateConfidence(nodes, connections, slots, suggestions, validationIssues)

  return { slots, variantNodeIds: [...variantNodeIds], suggestions, validationIssues, confidence }
}

/**
 * 同构重复动作检测（比 findVariantGroups 更宽松的「疑似」口径）：
 * 同 type + 上游签名一致 + 组内互不为上下游（A 在 B 下游是串行，不算重复）。
 * 与 findVariantGroups 的差异：不要求下游汇聚或并列终点——疑似组交给作者判断。
 */
function findSimilarActionGroups(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
): ToolNodeSnapshot[][] {
  const candidateTypes = ['llm-chat', 'image-generate', 'nine-grid-loop', 'video-generate']
  const candidates = nodes.filter((n) => candidateTypes.includes(n.type))
  if (candidates.length < 2) return []

  const typesById = new Map(nodes.map((node) => [node.id, node.type]))
  const incoming = new Map<string, Array<{ port: string; sourceNodeId: string }>>()
  for (const c of connections) {
    if (!typesById.has(c.sourceNodeId) || !typesById.has(c.targetNodeId)) continue
    if (!incoming.has(c.targetNodeId)) incoming.set(c.targetNodeId, [])
    incoming.get(c.targetNodeId)!.push({ port: c.targetPort, sourceNodeId: c.sourceNodeId })
  }
  const sigCache = new Map<string, string>()
  const sigVisiting = new Set<string>()
  // 结构签名只保留节点类型、连接端口和上游拓扑，忽略随机节点 id；
  // 这样「同样画布结构、不同 id 的并列分支」也能被识别为疑似重复动作。
  const upSig = (nodeId: string): string => {
    const cached = sigCache.get(nodeId)
    if (cached) return cached
    if (sigVisiting.has(nodeId)) return `${typesById.get(nodeId) ?? 'unknown'}(cycle)`
    sigVisiting.add(nodeId)
    const nodeType = typesById.get(nodeId) ?? 'unknown'
    const parents = (incoming.get(nodeId) ?? [])
      .map((edge) => `${edge.port}>${upSig(edge.sourceNodeId)}`)
      .sort()
      .join('|')
    const signature = `${nodeType}(${parents})`
    sigVisiting.delete(nodeId)
    sigCache.set(nodeId, signature)
    return signature
  }

  const downStream = (nodeId: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [nodeId]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of connections) {
        if (c.sourceNodeId === cur && !seen.has(c.targetNodeId)) {
          seen.add(c.targetNodeId)
          stack.push(c.targetNodeId)
        }
      }
    }
    return seen
  }
  const downCache = new Map<string, Set<string>>()
  const down = (id: string) => {
    if (!downCache.has(id)) downCache.set(id, downStream(id))
    return downCache.get(id)!
  }

  const groups = new Map<string, ToolNodeSnapshot[]>()
  for (const n of candidates) {
    const key = `${n.type}#${upSig(n.id)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(n)
  }

  const result: ToolNodeSnapshot[][] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const parallel = group.every((a, i) =>
      group.every((b, j) => i === j || (!down(a.id).has(b.id) && !down(b.id).has(a.id))),
    )
    if (parallel) result.push(group)
  }
  return result
}

undefined/** 由宽高反推比例档位（如 1024x1024 → '1:1'，1024x576 → '16:9'） */
export function ratioFromSize(w: unknown, h: unknown): string | null {
  const width = Number(w)
  const height = Number(h)
  if (!width || !height) return null
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b))
  let rw = width / g(width, height)
  let rh = height / g(width, height)
  // 归一到常见档位（容差 2%）
  const presets: Array<[number, number]> = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [3, 2], [2, 3]]
  for (const [pw, ph] of presets) {
    if (Math.abs(rw / rh - pw / ph) / (pw / ph) < 0.02) return `${pw}:${ph}`
  }
  // 约简
  while (rw < 1 || rh < 1 || rw > 32 || rh > 32) {
    if (rw > 32 || (rw >= 1 && rh >= 1 && rw > rh * 32)) { rw /= 2; rh /= 2; continue }
    if (rh > 32) { rw /= 2; rh /= 2; continue }
    break
  }
  return `${Math.round(rw)}:${Math.round(rh)}`
}

// ---------- 工作流校验 ----------

/**
 * 工作流完整性校验：检查结构问题、参数缺失、连接异常等
 */
function validateWorkflow(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
  slots: ToolSlot[],
  issues: ValidationIssue[]
): void {
  // 1. 检查孤立节点（无输入无输出）
  const nodeIds = new Set(nodes.map(n => n.id))
  const connectedNodes = new Set<string>()
  for (const c of connections) {
    connectedNodes.add(c.sourceNodeId)
    connectedNodes.add(c.targetNodeId)
  }
  const isolated = nodes.filter(n => !connectedNodes.has(n.id) && GENERATIVE_TYPES.has(n.type))
  if (isolated.length > 0) {
    issues.push({
      severity: 'warning',
      message: `检测到 ${isolated.length} 个孤立的生成节点，未连接到工作流`,
      nodeIds: isolated.map(n => n.id),
      category: 'connectivity'
    })
  }

  // 2. 检查无效连接（连到不存在的节点）
  const invalidConns = connections.filter(c => !nodeIds.has(c.sourceNodeId) || !nodeIds.has(c.targetNodeId))
  if (invalidConns.length > 0) {
    issues.push({
      severity: 'error',
      message: `检测到 ${invalidConns.length} 条无效连接（连接到不存在的节点）`,
      nodeIds: [],
      category: 'connectivity'
    })
  }

  // 3. 检查生成节点缺失必要参数
  for (const node of nodes) {
    if (!GENERATIVE_TYPES.has(node.type)) continue
    const d = def(node.type)
    if (!d) continue

    // 检查必填输入端口是否有连接或预设值
    const requiredPorts = Object.entries(d.inputs)
      .filter(([_, port]) => port.required)
      .map(([name]) => name)

    for (const port of requiredPorts) {
      const hasConnection = connections.some(c => c.targetNodeId === node.id && c.targetPort === port)
      const hasValue = portHasValue(node, port)
      // 面板 Slot 允许使用者运行时填必填值；没有 Slot 时才视为发布前错误。
      const hasRuntimeSlot = slots.some((slot) => slot.type !== 'result' && slot.hidden !== true && slot.targets?.some(
        (target) => target.nodeId === node.id && target.port === port,
      ))
      if (!hasConnection && !hasValue && !hasRuntimeSlot) {
        issues.push({
          severity: 'error',
          message: `节点「${nodeLabel(node)}」缺少必填参数：${port}`,
          nodeIds: [node.id],
          category: 'params'
        })
      }
    }
  }

  // 4. 检查是否有结果输出
  const hasResults = slots.some(s => s.type === 'result')
  if (!hasResults) {
    issues.push({
      severity: 'warning',
      message: '工作流未检测到任何输出结果节点',
      nodeIds: [],
      category: 'structure'
    })
  }

  // 5. 检查是否有输入入口
  const hasInputs = slots.some(s => s.type === 'upload' || s.type === 'text')
  if (!hasInputs) {
    issues.push({
      severity: 'warning',
      message: '工作流未检测到任何输入节点（上传/文本输入）',
      nodeIds: [],
      category: 'structure'
    })
  }

  // 6. 检查循环依赖
  const cycles = detectCycles(nodes, connections)
  if (cycles.length > 0) {
    issues.push({
      severity: 'error',
      message: `检测到循环依赖：${cycles.length} 个环路`,
      nodeIds: cycles.flat(),
      category: 'structure'
    })
  }
}

/**
 * 检测工作流中的循环依赖
 */
function detectCycles(nodes: ToolNodeSnapshot[], connections: ToolConnectionSnapshot[]): string[][] {
  const graph = new Map<string, string[]>()
  for (const n of nodes) graph.set(n.id, [])
  for (const c of connections) {
    if (graph.has(c.sourceNodeId)) {
      graph.get(c.sourceNodeId)!.push(c.targetNodeId)
    }
  }

  const cycles: string[][] = []
  const visited = new Set<string>()
  const recStack = new Set<string>()
  const path: string[] = []

  function dfs(nodeId: string): boolean {
    visited.add(nodeId)
    recStack.add(nodeId)
    path.push(nodeId)

    const neighbors = graph.get(nodeId) || []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true
      } else if (recStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor)
        cycles.push(path.slice(cycleStart))
        return true
      }
    }

    path.pop()
    recStack.delete(nodeId)
    return false
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId)
    }
  }

  return cycles
}

/**
 * 计算识别置信度评分（0-100）
 * 基于：slots完整性、建议数量、校验问题严重程度
 */
function calculateConfidence(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
  slots: ToolSlot[],
  suggestions: SlotSuggestion[],
  issues: ValidationIssue[]
): number {
  let score = 100

  // 扣分项1：有错误级校验问题，每个扣20分
  const errors = issues.filter(i => i.severity === 'error')
  score -= errors.length * 20

  // 扣分项2：有警告级校验问题，每个扣5分
  const warnings = issues.filter(i => i.severity === 'warning')
  score -= warnings.length * 5

  // 扣分项3：疑似建议过多（说明识别不确定），每个扣3分
  score -= suggestions.length * 3

  // 加分项1：有完整的输入输出结构
  const hasUpload = slots.some(s => s.type === 'upload')
  const hasResult = slots.some(s => s.type === 'result')
  if (hasUpload && hasResult) score += 10

  // 加分项2：有风格选择（说明工作流设计完善）
  const hasChoice = slots.some(s => s.type === 'choice')
  if (hasChoice) score += 5

  // 加分项3：节点规模适中（3-15个节点为佳）
  if (nodes.length >= 3 && nodes.length <= 15) score += 5

  // 边界处理
  return Math.max(0, Math.min(100, score))
}

// ===== 已发布工具的 slots 迁移（参数槽以最新识别结果为准）=====
// 背景：识别引擎会持续改进（例如「同组节点共享一个模型/规格槽」是后加的）。
// 已发布的工具把 slots 快照存进了数据库，不会自动重跑识别 → 老工具的参数槽覆盖不全，
// 表现为「只给第一个节点选了模型，其余节点自动兜底选模型」。
//
// 策略：参数类槽位（model / ratio）**始终以最新识别结果为准**（它们由画布结构推导，无作者语义），
// 只保留作者的 label / hidden 微调；其余槽位（upload/text/choice/number/result）保持原样，
// 因为那些可能含作者自定义的文案、选项与隐藏设置。
const PARAM_SLOT_TYPES = new Set(['model', 'ratio'])

export function reconcileParamSlots(
  nodes: ToolNodeSnapshot[],
  connections: ToolConnectionSnapshot[],
  storedSlots: ToolSlot[],
): ToolSlot[] {
  let analyzed: ToolSlot[]
  try {
    analyzed = analyzeToolSlots(nodes, connections).slots
  } catch {
    return storedSlots // 识别失败则原样返回，不阻断
  }
  const analyzedParams = analyzed.filter((s) => PARAM_SLOT_TYPES.has(s.type))
  if (analyzedParams.length === 0) return storedSlots

  // 作者的微调（label / hidden）按「槽类型 + 覆盖的节点集合」匹配，而不是按 id——
  // ⚠ 这里**刻意不继承 `required`**（Q-411）：它是拓扑推导值，不是作者意图。
  //   要支持作者自定义必填，必须同时改这里 + 向导 UI + 测试，三处缺一都会变成「存了但静默失效」。
  // id 里含节点 id，识别结果变化后 id 会变，按 id 匹配会丢微调。
  // 必须带上 type：同一批节点会同时有 model 槽和 ratio 槽（覆盖节点相同），
  // 只用节点集合做 key 会让两者的 label 互相串味。
  const targetKey = (s: ToolSlot) =>
    `${s.type}|${[...new Set(s.targets.map((t) => t.nodeId))].sort().join(',')}`
  const overrideByKey = new Map<string, { label?: string; hidden?: boolean }>()
  for (const s of storedSlots) {
    if (!PARAM_SLOT_TYPES.has(s.type)) continue
    const key = targetKey(s)
    if (key) overrideByKey.set(key, { label: s.label, hidden: s.hidden })
  }

  const reconciledParams = analyzedParams.map((s) => {
    const ov = overrideByKey.get(targetKey(s))
    return ov ? { ...s, label: ov.label ?? s.label, hidden: ov.hidden ?? s.hidden } : s
  })

  // 保留非参数槽（作者语义）在原位；参数槽整体替换为最新识别结果，
  // 并插到「原存储里第一个参数槽」的位置，保持面板顺序稳定。
  const ordered: ToolSlot[] = []
  let paramsPlaced = false
  for (const s of storedSlots) {
    if (PARAM_SLOT_TYPES.has(s.type)) {
      if (!paramsPlaced) {
        ordered.push(...reconciledParams)
        paramsPlaced = true
      }
      continue // 丢弃旧的参数槽
    }
    ordered.push(s)
  }
  if (!paramsPlaced) ordered.push(...reconciledParams)

  // result 槽兜底：它不是参数槽，所以上面「以存储为准」的逻辑不会补它。
  // 作者发布时若漏了 result（或老快照里被写坏），工具能跑但成果区永远为空——
  // 用户看到「生成中」转完却什么都没有。这里按最新识别结果补一个，
  // 已有 result 的作者版本（含自定义 label）保持不动。
  if (!ordered.some((s) => s.type === 'result')) {
    const analyzedResult = analyzed.filter((s) => s.type === 'result')
    if (analyzedResult.length > 0) ordered.push(...analyzedResult)
  }
  return ordered
}
