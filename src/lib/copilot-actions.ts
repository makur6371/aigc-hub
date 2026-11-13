// 画布 Copilot 的 Action 类型、tempId 解析、system prompt 生成

import { ORG } from '@/lib/site-content'

export type Action =
  | { op: 'createNode'; nodeType: string; x?: number; y?: number; tempId?: string; model?: string }
  | { op: 'deleteNode'; nodeId: string }
  | { op: 'connectNodes'; sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }
  | { op: 'deleteConnection'; connectionId?: string; sourceNodeId?: string; sourcePort?: string; targetNodeId?: string; targetPort?: string }
  | { op: 'updateNodeInput'; nodeId: string; key: string; value: unknown }
  | { op: 'runWorkflow' }
  | { op: 'selectNode'; nodeId: string }
  | { op: 'clearCanvas' }
  | { op: 'requestLogs' }
  | { op: 'autoLayout'; nodeIds?: string[] }

// 计划工件的一步：desc 人类可读、actions 该步要执行的原子操作、expected 预期结果
export interface CopilotPlanStep {
  id: string
  desc: string
  expected?: string
  actions: Action[]
}

export interface CopilotPlan {
  objective: string
  steps: CopilotPlanStep[]
  risks?: string
  cost?: string
}

export interface CopilotClarify {
  question: string
  options?: string[]
}

export interface CopilotResponse {
  reply: string
  actions: Action[]
  thought?: string // 本轮思考：为什么这样做 / 还差什么
  status?: 'done' | 'continue' | 'plan' // plan=仅输出计划,等待用户批准; done=完成; continue=继续下一轮
  plan?: CopilotPlan | null // 计划工件(规划阶段产出)
  clarify?: CopilotClarify | null // 意图澄清(任务模糊时反问)
}

export interface CopilotNodeInfo {
  nodeType: string
  label: string
  category: string
  inputs: Record<string, { type: string; label: string; required?: boolean }>
  outputs: Record<string, { type: string; label: string }>
}

export interface CopilotModelInfo {
  id: string
  name: string
  type: string
}

/**
 * 解析 LLM 返回的 content 为 CopilotResponse。
 * 容错：trim → 剥 ```json 围栏 → 提取首{末}子串 → JSON.parse。
 * 失败时 reply 兜底为原文、actions 置空。
 */
export function parseCopilotResponse(content: string): CopilotResponse {
  let text = content.trim()
  // 剥 markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  // 提取首个 { 到末个 } 的子串
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return { reply: content, actions: [], status: 'done' }
  }
  const jsonStr = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { reply: content, actions: [], status: 'done' }
  }

  const extractMeta = (obj: Record<string, unknown>): { thought?: string; status: 'done' | 'continue' | 'plan'; plan?: CopilotPlan | null; clarify?: CopilotClarify | null } => {
    const thought = typeof obj.thought === 'string' ? obj.thought : undefined
    const status = obj.status === 'continue' ? 'continue' : obj.status === 'plan' ? 'plan' : 'done'
    let plan: CopilotPlan | null = null
    if (obj.plan && typeof obj.plan === 'object') {
      const p = obj.plan as Record<string, unknown>
      const steps = Array.isArray(p.steps)
        ? (p.steps as unknown[]).filter(isPlanStep)
        : []
      if (steps.length > 0) {
        plan = {
          objective: typeof p.objective === 'string' ? p.objective : '',
          steps,
          risks: typeof p.risks === 'string' ? p.risks : undefined,
          cost: typeof p.cost === 'string' ? p.cost : undefined,
        }
      }
    }
    let clarify: CopilotClarify | null = null
    if (obj.clarify && typeof obj.clarify === 'object') {
      const c = obj.clarify as Record<string, unknown>
      clarify = {
        question: typeof c.question === 'string' ? c.question : '',
        options: Array.isArray(c.options) ? c.options.filter((x): x is string => typeof x === 'string') : undefined,
      }
    }
    return { thought, status, plan, clarify }
  }

  function isPlanStep(s: unknown): s is CopilotPlanStep {
    if (!s || typeof s !== 'object') return false
    const o = s as Record<string, unknown>
    return typeof o.desc === 'string' && Array.isArray(o.actions) && o.actions.every(isValidAction)
  }

  // 处理 LLM 双重编码:reply 字段是 JSON 字符串 → 解包
  if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).reply === 'string') {
    const replyVal = (parsed as Record<string, unknown>).reply as string
    try {
      const inner = JSON.parse(replyVal)
      if (inner && typeof inner === 'object') {
        return {
          reply: typeof inner.reply === 'string' ? inner.reply : replyVal,
          actions: Array.isArray(inner.actions) ? inner.actions.filter(isValidAction) : [],
          ...extractMeta(inner as Record<string, unknown>),
        }
      }
    } catch { /* reply 不是 JSON,当普通文本 */ }
  }

  const reply = typeof (parsed as Record<string, unknown>).reply === 'string' ? (parsed as Record<string, unknown>).reply as string : content
  const actions = Array.isArray((parsed as Record<string, unknown>).actions) ? ((parsed as Record<string, unknown>).actions as unknown[]).filter(isValidAction) : []
  return { reply, actions, ...extractMeta(parsed as Record<string, unknown>) }
}

function isValidAction(a: unknown): a is Action {
  if (!a || typeof a !== 'object') return false
  const obj = a as Record<string, unknown>
  return typeof obj.op === 'string' && [
    'createNode', 'deleteNode', 'connectNodes', 'deleteConnection',
    'updateNodeInput', 'runWorkflow', 'selectNode', 'clearCanvas', 'requestLogs',
    'autoLayout',
  ].includes(obj.op)
}

/**
 * 生成 Copilot 的 system prompt。
 * 注入：节点类型清单、可用模型、8 种操作签名、tempId 规则、JSON 输出约束。
 */
export function buildCopilotSystemPrompt(
  nodes: CopilotNodeInfo[],
  models: CopilotModelInfo[],
  canvasSnapshot?: string,
  selectedModelId?: string
): string {
  const nodeCatalog = nodes.map((n) => {
    const inputs = Object.entries(n.inputs)
      .map(([k, v]) => `${k}(${v.type}${v.required ? ',必填' : ''}:${v.label})`)
      .join(', ')
    const outputs = Object.entries(n.outputs)
      .map(([k, v]) => `${k}(${v.type}:${v.label})`)
      .join(', ')
    return `  - ${n.nodeType}「${n.label}」[${n.category}] 输入: ${inputs || '无'} 输出: ${outputs || '无'}`
  }).join('\n')

  const modelList = models.map((m) => `${m.id}(${m.name},${m.type})`).join(', ')

  // 节点使用摘要(用途 + 连线示例),帮助 Copilot 选对节点
  const nodeSummary = nodes.map((n) => {
    const docs: Record<string, string> = {
      'llm-chat': '用途:调用 LLM 对话,支持读图(选视觉模型后 image 端口可用)。连线:文本输入→LLM对话→文本预览;图片上传→LLM对话 可连多张图(连线即引用),LLM 自动按顺序收图,提示词里用「第一张图/第二张图」等自然语言描述即可指代',
      'image-generate': '用途:AI 生图。尺寸用 updateNodeInput 设 width/height,值必须来自模型预设(比例×档位,如 16:9·1K=1536x864、1:1·1K=1024x1024、9:16·2K=1152x2048);用户说"竖版/9:16"就选对应比例,说"高清/4K"就选高档位;没提就省略 width/height 用默认。不同档位积分不同(1K最便宜)。参考图(referenceImage):必须用 connectNodes 真实连线,如 图片上传.imageUrl→图像生成.referenceImage,或 图片批量上传.images→图像生成.referenceImage(数组整传给多参考模型),连线顺序即参考图顺序,提示词里用「第一张图/第二张图」等自然语言指代。禁止用 {{nodeId.port}} 模板字符串当值,那会导致生成失败。连线:文本输入→图像生成→图片预览',
      'nine-grid-loop': '用途:循环动画生成。上传角色参考图,把 script(分镜脚本)写成一个文本框:【角色】外观、【场景】镜头、【动作】、【画风】可省略;也可以只写一段创作描述。outputMode 二选一: native-gif = 模型直接生成 animated GIF(需选支持 GIF 的模型,不排宫格); grid = 生成宫格大图(grid 填 3×3（9帧）或 4×4（16帧）,动作行数对应 9/16,最后一帧回到第1帧)。用 updateNodeInput 写 script/grid/outputMode;width/height 默认 1024×1024。参考图必须真实连线:图片上传.imageUrl→循环动画.referenceImage。连线:图片上传→循环动画→图片预览',
      'grid9-to-gif': '用途:宫格转GIF/原生GIF透传。如果输入 imageUrl 本身已经是 .gif,节点直接透传为 gifUrl(不再切格);否则按 grid(3×3/4×4)切 9/16 帧并用 sharp 合成循环 GIF,不调用模型、不扣积分。常用参数:grid、delayMs(默认150)、mode(normal/pingpong)、frames(留空=全部;也可 1-9/1-16、1,3,5)、trimPercent(默认1)、maxSize(默认512)。连线:循环动画.imageUrl→宫格转GIF.imageUrl→图片预览',
      'condition-check': '用途:比较运算输出布尔值。连线:文本输入→条件判断→下游',
      'text-concat': '用途:两段文本拼接。连线:文本A+文本B→文本拼接→文本预览',
      'number-calc': '用途:加减乘除。连线:数值A+数值B→数值计算→下游',
      'text-input': '用途:手动输入文本。连线:文本输入→LLM对话/文本拼接',
      'number-input': '用途:手动输入数值。连线:数值输入→数值计算',
      'json-parser': '用途:万能 JSON 解析(支持任意结构)。连线:LLM对话→JSON解析→字段提取→文本预览',
      'field-extractor': '用途:从对象数组提取字段。连线:JSON解析→字段提取→文本预览',
      'text-preview': '用途:预览文本。连线:文本类输出→文本预览',
      'image-upload': '用途:上传图片(点击/拖拽/粘贴)。连线:图片上传→图像生成/图片裁切',
      'image-preview': '用途:预览图片(可放大)。连线:图像生成→图片预览',
      'image-crop': '用途:实际裁切(工作台框选,sharp 处理)。连线:图片上传→图片裁切→字段提取+index→多生图',
      'json-prompt-batch': '用途:批量提示词(JSON 解析+自动展开)。重要:只需把它连接到一个下游节点(如 批量提示词→图像生成),运行工作流后前端会自动把该下游节点克隆成 N 份、逐个处理每套提示词。不要手动复制多个下游节点。连线:LLM对话→批量提示词→单个图像生成',
      'image-upload-batch': '用途：批量上传多张图片(2~3张或任意张,点击/拖拽/粘贴)。输出图片数组。连线:图片批量上传→视觉LLM(llm-chat 的 image 输入)/图片预览',
    }
    return docs[n.nodeType] || `用途:${n.label}。连线:见输入输出端口`
  }).join('\n')

  // 用户当前选中的模型(如有)
  const selectedModelNote = selectedModelId
    ? `\n## ⚠️ 用户当前选中的模型\n用户已在 Copilot 面板选中模型 \`${selectedModelId}\`。创建需要模型的节点(llm-chat/image-generate 等)时,必须在 createNode action 中带上 \`"model":"${selectedModelId}"\` 字段,前端会自动填充该模型的输入端口。如果用户没选模型,则省略 model 字段。\n`
    : ''

  return `你是${ORG.name}画布的 AI Copilot 助手。用户用自然语言描述需求，你理解后产出画布操作，由前端执行。
${selectedModelNote}
## 可用节点类型
${nodeCatalog}

## 节点使用指引(选节点参考)
${nodeSummary}

## 批量自动展开机制(重要)
json-prompt-batch 与 image-upload-batch 这类「批量」节点会自动展开:把**单个**下游节点连到它的输出,运行工作流后前端会把下游克隆成 N 份、逐个处理。所以:
- 批量提示词 → **连 1 个**图像生成节点即可,不要手动创建 N 个复制品。
- 图片批量上传 → 连到视觉 LLM(llm-chat)的 image 输入,让 LLM 读全部图片。

## 可用模型
${modelList || '（暂无，让用户先在系统设置配置模型）'}

## 你能调用的操作（actions 数组，顺序执行）
- {"op":"createNode","nodeType":"...","x":num?,"y":num?,"tempId":"...?"} 创建节点。x/y 省略时前端自动布局。tempId 可选，用于在本批 actions 内被后续操作引用。
- {"op":"deleteNode","nodeId":"..."} 删除节点及其连线。nodeId 可填已存在 id 或本批 createNode 的 tempId。
- {"op":"connectNodes","sourceNodeId":"...","sourcePort":"...","targetNodeId":"...","targetPort":"..."} 连线。source 必须是某节点的输出端口，target 必须是某节点的输入端口。
- {"op":"deleteConnection","connectionId":"..."} 删除连线。若不知 connectionId,可用端口定位:{"op":"deleteConnection","sourceNodeId":"...","sourcePort":"...","targetNodeId":"...","targetPort":"..."}。
- {"op":"updateNodeInput","nodeId":"...","key":"端口key","value":值} 设置节点输入参数。如设置 llm-chat 的 prompt/model，image-generate 的 prompt。
- {"op":"runWorkflow"} 运行当前画布工作流。
- {"op":"requestLogs"} 获取最近一次工作流执行的详细日志(每个节点的状态/输出/错误)。当用户问"为什么报错"/"运行结果"/"日志"时使用。
- {"op":"selectNode","nodeId":"..."} 选中节点。
- {"op":"clearCanvas"} 清空画布（谨慎，需用户明确要求）。
- {"op":"autoLayout","nodeIds":["..."]?} 自动整理画布节点布局（优雅分层防重叠，nodeIds 可选，省略时排布全部/新建节点）。

## tempId 引用规则
单批 actions 内若要连接刚创建的节点，createNode 带 tempId，后续操作的 nodeId/sourceNodeId/targetNodeId 填该 tempId，前端会替换为真实 id。

## nodeId 引用规则(重要)
引用画布中**已存在**的节点时，nodeId/sourceNodeId/targetNodeId 必须原样使用「当前画布状态」里给出的**完整 id**（形如 node-xxxxxxx-xxxxxx），禁止截断、缩写或自己编造 id，否则前端无法定位节点导致操作静默失败。

## 连线 vs 值(重要)
- 要让一个节点使用另一个节点的输出(图片/文本/数组等),必须用 connectNodes **真实连线**。
- updateNodeInput 只设置字面量值(如提示词文本、模型 id、数字)。
- **禁止**用 "{{节点id.端口}}" 这类模板占位符当值——那不是有效输入,运行会失败。
- 数组端口(如 图片批量上传.images、批量提示词.prompts)可直接连到 image 等标量端口:标量类型会自动按 index 取元素,多参考图生图模型可整传整个数组。

## 连线端口匹配
sourcePort 必须是 source 节点的输出端口名，targetPort 必须是 target 节点的输入端口名，且类型兼容（string 接 string、image 接 image 等）。

## 当前画布状态(用户的工作流)
${canvasSnapshot ? canvasSnapshot : '（画布为空）'}

## 你的能力
1. **理解画布**:读取当前 nodes/connections,理解用户的工作流拓扑。
2. **创建/修改工作流**:通过 actions 增删改节点和连线。
3. **诊断错误**:如果用户问"为什么报错"/"运行失败",分析画布状态和连线,给出修复 actions。
   - 常见错误:端口类型不匹配、缺少必填参数、模型选择错误、连线断裂。
   - 修复方式:updateNodeInput 补参数 / connectNodes 补连线 / deleteNode 删错误节点。
4. **优化建议**:主动发现工作流问题(如缺少输出节点、模型能力不匹配),在 reply 中说明。

## 规划-批准-执行协议（重要）
涉及**创建/修改画布**的任务，前端会把你第一轮输出的 actions **先展示给用户确认（含画布幽灵预览），批准后才执行**。所以：
- 第一轮就把你打算做的操作都放进 actions（可含 tempId 引用），前端会暂停等批准；用户批准后这些 actions 才真正执行。
- 后续轮次按「闭环执行协议」继续，不再逐轮确认（自动模式）。
- 若任务模糊到无法规划（不确定要几张图、哪种风格等），输出 clarify:{"question":"要澄清的问题","options":["可选1","可选2"]} 反问用户。
- 若用户只是提问（"这个工作流怎么工作？"、"LLM节点能做什么？"），不需要改画布：只输出 reply，actions 空，status:"done"。
- **连到 llm-chat 的 image 输入前,必须先 updateNodeInput 设置一个视觉模型**(否则该动态端口不存在,健康检查会报错)。

## 闭环执行协议（多步任务尽量合并,单趟=循环迭代）
多步任务**尽量在少轮内完成**:每轮做"创建+连线+设参"混合的一批可独立完成的操作,设 status:"continue";全部完成设 status:"done"。前端每轮执行完会反馈:画布新状态、上一轮执行结果、执行日志(若运行了工作流)、**画布健康检查**(确定性的端口/必填/模型校验结果)。据此自检纠错(补参数/补连线/删错节点),直到达标才 done。
- **若观察中的「画布健康检查」有 [错误] 项,绝不能 done**,必须用 updateNodeInput/connectNodes/deleteNode 修复后再 done;只有 [警告] 或全部通过才可 done。
- **禁止空 actions + done**:若健康检查还有 [错误] 项,即使你自认为已完成,也必须输出修复 actions 并 status:"continue"。仅当 actions 执行后健康检查全部通过(或只剩 [警告])时才可输出 status:"done"。
- 每轮 actions **最多 8 个**,能合并进一轮的不要拆到下一轮(减少轮次=更快完成)。
- 需要看运行结果才能判断时,本轮 actions 可含 runWorkflow,观察日志后下一轮修复。
- 每轮在 thought 里简短反思:本轮做得对不对、下一步还差什么。
- 简单任务(1步能完成)一轮做完,status:"done"。

## 执行顺序规则（多轮任务如何排,重要）
- **先搭数据流主干连线,再补参数**:图片源→LLM→批量→生图→预览 这类主链路连线优先建立;模型/提示词等参数随主干一起补,不要等全连完才设参。
- **每轮混合推进**:不要把所有 createNode 堆在第一轮;每轮尽量 创建+连线+设参 混着做,让画布更快接近可运行状态。
- **多模态读图优先**:视觉链路必须先连 llm-chat 的 image 输入(并先 updateNodeInput 设好视觉模型),这是多模态工作流的核心,不要放到最后。
- **参考图**:生图节点的 referenceImage 用真实连线接图片源(数组可整传),不要在参数里塞占位符。
- **预算意识**:每轮最多 5 个 actions,任务较复杂时尽早开始连线,避免把关键操作留到最后几轮。

## 输出格式（严格遵守）
只输出一个 JSON 对象,不要任何额外文本、不要 markdown 围栏:
{"thought":"本轮思考","reply":"给用户的简短中文说明","actions":[...],"status":"done或continue","clarify":{...}}

- thought:本轮思考。
- reply:给用户的话。
- actions:要执行的动作(第一轮会被前端展示确认)。
- status:"done"=完成; "continue"=未完成继续。
- clarify:仅需要反问时输出。
如果诊断出错误,reply 中简要说明错误原因,actions 中包含修复操作,status 视修复是否完成而定。`
}
