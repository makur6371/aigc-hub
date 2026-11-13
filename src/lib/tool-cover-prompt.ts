import { ALL_TOOL_CATEGORIES } from '@/lib/constants/categories'
import { ORG } from '@/lib/site-content'
import type { ToolSlot } from '@/lib/tool-slots'

// ===== 工具封面提示词生成 =====
//
// 管理员在「内容管理 → 工具管理」里给工具配封面时，需要一段能直接丢给生图模型的提示词。
// 手写每个工具的 INPUT / WORKFLOW / RESULT 很费事，而这些信息在工具快照里本来就有：
//   INPUT    ← upload / text 槽位
//   WORKFLOW ← 节点标签的拓扑序
//   RESULT   ← result 槽位指向的节点
// 所以这里做「按工具自动填变量」，管理员只需微调措辞。
//
// 视觉规范（液态玻璃 + 芋紫）与模板保持一致，保证所有工具封面看起来出自同一套产品。

/** 模板里的 6 种分类视觉语言 */
export type CoverStyleKey =
  | 'ECOMMERCE'
  | 'CREATIVE'
  | 'STORY'
  | 'PRODUCTIVITY'
  | 'VIDEO'
  | 'PROFESSIONAL'

/**
 * 本站工具分类 → 模板视觉语言。
 * 分类是站内枚举（constants/categories.ts），模板是外部概念，两边不是一一对应，
 * 所以显式列出映射，而不是用关键词猜（猜错会让封面风格跑偏）。
 */
const STYLE_BY_CATEGORY: Record<string, CoverStyleKey> = {
  // 01 电商商拍：商品主体 + 商业摄影质感
  电商商拍: 'ECOMMERCE',
  服饰穿戴: 'ECOMMERCE',
  产品渲染: 'ECOMMERCE',
  海报设计: 'ECOMMERCE',
  品牌设计: 'ECOMMERCE',
  // 02 创意生图：创作过程 + 作品本身是焦点
  文生图: 'CREATIVE',
  图生图: 'CREATIVE',
  图片编辑: 'CREATIVE',
  // 03 AI 漫剧 / 影视：角色一致性 + 分镜
  'AI 漫剧': 'STORY',
  角色设计: 'STORY',
  // 04 AI 效率：信息流 + 自动化
  自媒体创作: 'PRODUCTIVITY',
  语音识别: 'PRODUCTIVITY',
  文字识别: 'PRODUCTIVITY',
  通用工具: 'PRODUCTIVITY',
  // 05 AI 视频：动态 + 时间轴
  // 视频类分类已于 2026-10-18 合并为「视频生成」（见 constants/categories.ts）。
  // 下面 4 个旧键保留：库里的历史工具还带着旧分类值，后台改封面时仍会命中。
  视频生成: 'VIDEO',
  文生视频: 'VIDEO',
  图生视频: 'VIDEO',
  首尾帧生成视频: 'VIDEO',
  多图参考生成视频: 'VIDEO',
  音频生成: 'VIDEO',
  音乐生成: 'VIDEO',
  // 06 专业工作流：精密节点 + 专业成果
  建筑设计: 'PROFESSIONAL',
}

export const COVER_STYLE_LABELS: Record<CoverStyleKey, string> = {
  ECOMMERCE: '01 电商商拍',
  CREATIVE: '02 创意生图',
  STORY: '03 AI 漫剧 / 影视',
  PRODUCTIVITY: '04 AI 效率',
  VIDEO: '05 AI 视频',
  PROFESSIONAL: '06 专业工作流',
}

/** 分类 → 视觉语言；未知分类按「创意生图」兜底（生图类工具占多数） */
export function styleForCategory(category: string | null | undefined): CoverStyleKey {
  if (!category) return 'CREATIVE'
  return STYLE_BY_CATEGORY[category] ?? 'CREATIVE'
}

/** 分类风格段落（模板「分类风格约束」的对应分支） */
const STYLE_BLOCK: Record<CoverStyleKey, string> = {
  ECOMMERCE: `Visual direction: commercial photography + product showcase + e-commerce workflow

Emphasize:
- the product as the hero
- commercial photography quality
- multiple scenes / usages
- product consistency across shots
- detail-page / product-set output
- professional e-commerce visual polish

Input is usually: product photo / model photo / product assets
Result is usually: product image set / detail page / multi-scene commercial images

Avoid: over-technical sci-fi styling, complex dashboard UI, abstract art effects.`,

  CREATIVE: `Visual direction: creative transformation + visual imagination + artistic generation

Emphasize:
- the input image or prompt
- the AI creation process
- style transformation
- multiple visual outcomes
- the artwork itself

You may use: image fragments, light particles, flowing color, AI generation nodes.
The generated artwork must be the main visual focus.

Avoid: over-commercial look, over-procedural flowchart feel.`,

  STORY: `Visual direction: cinematic storytelling + character consistency + storyboard

Emphasize:
- the same character
- multiple shots
- scene changes
- storyboard panels
- cinematic feel
- continuous narrative

You may use: cinematic frames, storyboard panels, shot-to-shot connectors, filmstrip arrangement.
If the tool is about character consistency, you MUST highlight SAME CHARACTER -> DIFFERENT SCENES / SHOTS.

Avoid: generic comic collage, over-cartoonish UI.`,

  PRODUCTIVITY: `Visual direction: information flow + automation + intelligent workspace

Emphasize:
- documents
- text
- data
- tasks
- the agent
- automatic execution
- a final structured deliverable

You may use: document cards, task nodes, information flow, agent nodes, result documents.
Core logic: task / information -> AI processing -> a directly usable deliverable

Avoid: walls of text, screenshots of legacy office software, complex admin backends.`,

  VIDEO: `Visual direction: motion + cinematic frames + timeline + video generation

Emphasize:
- shots
- motion
- continuous frames
- video frames
- timeline
- the finished film

You may use: cinematic frames, video frames, timeline, playback nodes, motion trails.
Core logic: image / prompt / footage -> AI motion generation -> video result

Avoid: making it look like a traditional video-editing software interface.`,

  PROFESSIONAL: `Visual direction: precision + structured workflow + professional output

Emphasize:
- nodes
- data flow
- parameters
- professional assets
- a precise workflow
- a professional final result

You may use: code snippets, 3D models, data charts, design drafts, node networks.
Core logic: professional input -> AI processing -> professional output

Avoid: overly complex technical interfaces.`,
}

/** 模板的「特殊构图规则」，按工具结构自动挑一条 */
export type CoverComposition =
  | 'SINGLE'
  | 'MULTI_OUT'
  | 'MULTI_STYLE'
  | 'GRID9'
  | 'GRID9_HD'
  | 'AGENT'
  | 'VIDEO'
  | 'CHARACTER'

const COMPOSITION_BLOCK: Record<CoverComposition, string> = {
  SINGLE: 'INPUT -> AI -> RESULT',
  MULTI_OUT: 'INPUT -> AI -> RESULT 1 / RESULT 2 / RESULT 3',
  MULTI_STYLE: 'INPUT -> STYLE A/B/C/D -> MULTIPLE RESULTS',
  GRID9: 'SOURCE -> AI -> 3x3 GRID',
  GRID9_HD: 'SOURCE -> AI -> 3x3 GRID -> SELECT -> HD RESULTS',
  AGENT: 'TASK -> PLAN -> EXECUTE -> RESULT',
  VIDEO: 'SCRIPT / IMAGE -> SHOTS -> VIDEO',
  CHARACTER: 'CHARACTER -> SCENES / SHOTS -> SAME CHARACTER',
}

export interface CoverPromptVars {
  toolName: string
  toolDescription: string
  category: string
  input: string
  workflow: string
  output: string
  coreValue: string
  style: CoverStyleKey
  composition: CoverComposition
}

/** 生成完整封面提示词（模板 + 已填变量 + 分类风格 + 构图规则） */
export function buildCoverPrompt(v: CoverPromptVars): string {
  return `Create a premium 4:3 landscape feature cover for an AI tool called ${v.toolName}.

The cover must visually communicate:

INPUT -> AI WORKFLOW -> RESULT

Use the following description to determine the exact visual content:
${v.toolDescription}

## Composition

Use a clear left-to-right composition:

Left 30% - INPUT
Visually represent ${v.input} as the main source material, placed inside a premium rounded translucent glass card.

Center 35% - AI WORKFLOW
Visually represent ${v.workflow} using elegant flowing connector lines, AI processing nodes, subtle particles, transformation effects or appropriate workflow elements.

Right 35% - RESULT
Visually showcase ${v.output} as the most impressive and visually dominant result.

The workflow must be visually understandable without reading the text.
If there are multiple outputs, use branching connections.
If there are multiple processing steps, show them sequentially.
If the tool's main value is transformation, make the transformation itself the visual focal point.

## Brand visual language

The website uses a translucent liquid glass + soft taro purple visual identity.
Always maintain:

- 4:3 landscape
- light, airy premium background
- soft taro-purple / lavender primary accent
- subtle blue and pink-purple gradients
- translucent liquid-glass cards
- frosted glass surfaces
- soft blurred reflections
- rounded corners
- soft ambient shadows
- subtle glow
- elegant thin connector lines
- clean modern AI SaaS aesthetic
- generous negative space
- realistic, high-quality generated imagery
- sophisticated but approachable

The cover should feel like a premium AI product feature, not a presentation slide.

## Visual hierarchy

1. ${v.coreValue} - strongest
2. INPUT -> WORKFLOW -> RESULT
3. Tool name
4. Minimal supporting labels

Use very little text. Text should only help identify the tool and major workflow stages.
Do not use paragraphs.
Do not fill the image with UI.
Do not create a dense infographic.
Do not make every element equally prominent.

## Category style (${COVER_STYLE_LABELS[v.style]})

${STYLE_BLOCK[v.style]}

## Composition rule for this tool

${COMPOSITION_BLOCK[v.composition]}

Do not break the tool's own logic just to follow a fixed layout.

## Final constraints

The cover must satisfy all of the following:

- 4:3 landscape
- clear INPUT -> WORKFLOW -> RESULT structure
- ${v.coreValue} must be immediately visible
- large visual elements
- strong focal point
- minimal text
- translucent liquid-glass UI language
- soft taro-purple primary theme
- light premium background
- realistic high-quality visual assets
- elegant connector lines
- generous negative space
- consistent visual identity across the ${ORG.name}

Avoid:

- dense infographic layouts
- excessive text
- complicated dashboards
- generic SaaS screenshots
- ordinary PowerPoint style
- excessive icons
- excessive decorative elements
- dark cyberpunk style
- overly futuristic sci-fi
- unrelated visual elements
- weak or ambiguous workflow
- making every element equally prominent

The final image should communicate the tool's value within one second and look like a cohesive feature cover from the same AI product ecosystem.`
}

// ===== 从工具快照推导变量 =====

const ACCEPT_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文字',
}

/**
 * 节点在封面里该怎么「画」。
 * 返回 null 表示这个节点不该出现在 WORKFLOW 里——要么它是 INPUT（上传/文字口，
 * 已经在 Left 30% 画过了），要么只是预览展示（不是处理步骤）。
 */
function describeNode(type: string, label: string): string | null {
  switch (type) {
    case 'image-upload':
    case 'image-upload-batch':
    case 'audio-upload':
      // 上传口 = INPUT，已在左侧画过，不再重复出现在工作流里
      return null
    case 'text-input':
    case 'text-preview':
      return null
    case 'llm-chat':
      return 'AI 理解与改写'
    case 'image-generate':
      return `${label}（AI 生图）`
    case 'nine-grid-loop':
      return `${label}（九宫格循环帧）`
    case 'grid9-to-gif':
      return `${label}（合成 GIF）`
    case 'image-crop':
      return `${label}（切分画面）`
    case 'video-generate':
      return `${label}（AI 生成视频）`
    case 'audio-generate':
    case 'music-generate':
    case 'tts-generate':
    case 'sfx-generate':
      return `${label}（AI 生成音频）`
    case 'voice-isolate':
      return `${label}（人声分离）`
    case 'transcribe':
      return `${label}（语音转文字）`
    case 'ocr':
      return `${label}（文字识别）`
    case 'image-preview':
    case 'video-preview':
    case 'audio-preview':
      // 预览节点只是展示，不是工作流步骤
      return null
    default:
      return label
  }
}

export interface ToolCoverInput {
  name: string
  description: string | null
  category: string | null
  slots: ToolSlot[]
  nodes: Array<{ id: string; type: string; label: string }>
  connections: Array<{ sourceNodeId: string; targetNodeId: string }>
}

/**
 * 从工具快照推导封面提示词变量。
 *
 * 推导规则（全部基于工具已有的槽位/节点，不额外让管理员填）：
 *   input     ← upload / text 槽位的 label
 *   workflow  ← 节点拓扑序，去掉上传与预览节点（那些是「输入/展示」不是「处理」）
 *   output    ← result 槽位指向的节点 label；没有则用最后一个处理步骤
 *   coreValue ← 工具描述（一句话卖点）
 */
export function deriveCoverVars(tool: ToolCoverInput): CoverPromptVars {
  const { slots, nodes, connections } = tool

  // ---- input ----
  const inputParts: string[] = []
  for (const s of slots) {
    if (s.hidden) continue
    if (s.type === 'upload') {
      const kinds = (s.accept ?? ['image']).map((a) => ACCEPT_LABEL[a] ?? a).join(' / ')
      inputParts.push(`${s.label}（${kinds}）`)
    } else if (s.type === 'text') {
      inputParts.push(`${s.label}（文字描述）`)
    }
  }
  const input = inputParts.length > 0 ? inputParts.join(' + ') : '用户上传的素材'

  // ---- workflow：拓扑序，只保留「处理」节点 ----
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const c of connections) {
    if (!byId.has(c.sourceNodeId) || !byId.has(c.targetNodeId)) continue
    adj.get(c.sourceNodeId)!.push(c.targetNodeId)
    inDegree.set(c.targetNodeId, (inDegree.get(c.targetNodeId) ?? 0) + 1)
  }
  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const ordered: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    ordered.push(id)
    for (const next of adj.get(id) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1)
      if ((inDegree.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  // 有环时拓扑序会漏节点，补上剩余的，保证封面描述不丢步骤
  for (const n of nodes) if (!ordered.includes(n.id)) ordered.push(n.id)

  const described = ordered
    .map((id) => byId.get(id)!)
    .map((n) => ({ type: n.type, text: describeNode(n.type, n.label) }))
    .filter((d): d is { type: string; text: string } => d.text !== null)

  // 同类节点连续出现时合并：九宫格 9 个生图节点逐个列出来，封面描述会变成一长串
  // 「第1格 -> 第2格 -> … -> 第9格」，读起来像流水账，也不利于模型抓重点。
  const merged: Array<{ type: string; count: number; first: string }> = []
  for (const d of described) {
    const last = merged[merged.length - 1]
    if (last && last.type === d.type) last.count++
    else merged.push({ type: d.type, count: 1, first: d.text })
  }
  const workflowSteps = merged.map((m) => {
    if (m.count === 1) return m.first
    // 多个同类：取「（…）」前的部分 + 数量，例如「第1格（AI 生图）」→「AI 生图 ×9」
    const base = m.first.replace(/^[^（]*（/, '').replace(/）$/, '')
    return `${base} ×${m.count}`
  })
  const workflow = workflowSteps.length > 0 ? workflowSteps.join(' -> ') : 'AI 处理'

  // ---- output ----
  const resultTargets = new Set<string>()
  for (const s of slots) {
    if (s.type !== 'result') continue
    for (const t of s.targets) resultTargets.add(t.nodeId)
  }
  const outputNodes = nodes.filter((n) => resultTargets.has(n.id))
  // 成果同样合并同类：九宫格 9 个结果不必逐个列名
  const output = outputNodes.length > 0
    ? summarizeOutputs(outputNodes)
    : (workflowSteps.length > 0 ? workflowSteps[workflowSteps.length - 1] : 'AI 生成的成果')

  const description = tool.description?.trim() || ''

  return {
    toolName: tool.name,
    toolDescription: description || `${tool.name}：上传素材，由 AI 自动处理并生成可用成果。`,
    category: tool.category ?? '未分类',
    input,
    workflow,
    output,
    coreValue: description || `${tool.name} 一键出成果`,
    style: styleForCategory(tool.category),
    composition: pickComposition(tool, slots, nodes),
  }
}

/** 按工具结构挑构图规则（模板「特殊构图规则」） */
/**
 * 归纳成果节点：同类节点多时只报「类型 ×N + 一个代表名」，
 * 避免九宫格/多风格工具输出一长串「第1格 / 第2格 / …」。
 */
function summarizeOutputs(nodes: Array<{ type: string; label: string }>): string {
  const groups: Array<{ type: string; labels: string[] }> = []
  for (const n of nodes) {
    const last = groups[groups.length - 1]
    if (last && last.type === n.type) last.labels.push(n.label)
    else groups.push({ type: n.type, labels: [n.label] })
  }
  return groups
    .map((g) => (g.labels.length === 1 ? g.labels[0] : `${g.labels.length} 张成果图（如「${g.labels[0]}」）`))
    .join(' / ')
}

function pickComposition(
  tool: ToolCoverInput,
  slots: ToolSlot[],
  nodes: Array<{ id: string; type: string; label: string }>,
): CoverComposition {
  const types = new Set(nodes.map((n) => n.type))
  const style = styleForCategory(tool.category)
  const choiceSlot = slots.find((s) => s.type === 'choice' && !s.hidden)
  const optionCount = choiceSlot?.options?.length ?? 0
  const hasCrop = types.has('image-crop')
  const resultSlot = slots.find((s) => s.type === 'result')
  const resultCount = resultSlot?.targets.length ?? 0

  // 角色一致性优先于其它（同一角色多镜头是这类工具的核心卖点）
  if (style === 'STORY' && /角色|人物|一致性/.test(tool.name + (tool.description ?? ''))) return 'CHARACTER'
  if (style === 'VIDEO' || types.has('video-generate')) return 'VIDEO'
  // 九宫格：先切分再逐格重绘 → 带高清步骤
  if (hasCrop && optionCount > 0) return 'GRID9_HD'
  if (hasCrop) return 'GRID9'
  // 多风格：风格组有多个选项
  if (optionCount > 1) return 'MULTI_STYLE'
  if (resultCount > 1) return 'MULTI_OUT'
  // 多步骤（有 LLM 参与编排）
  if (types.has('llm-chat') && nodes.length > 4) return 'AGENT'
  return 'SINGLE'
}

/** 供管理端下拉：可选分类（站内枚举） */
export const COVER_CATEGORY_OPTIONS = [...ALL_TOOL_CATEGORIES]
