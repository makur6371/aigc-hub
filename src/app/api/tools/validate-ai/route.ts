import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { streamChatToUpstream } from '@/lib/llm-provider'
import { findDefaultModel } from '@/lib/model-catalog'

/**
 * AI 辅助工作流问题检测（批4：与硬编码 validateWorkflow 双套机制并存）
 * 输入画布快照，返回 LLM 找出的潜在问题列表（语义层：提示词空泛、结构冗余、
 * 参数矛盾、模型选型不当等规则引擎覆盖不到的问题）。
 */
interface CanvasNodeLite {
  id: string
  type: string
  label?: string
  inputs?: Record<string, unknown>
}
interface CanvasConnLite {
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
}

export interface AiIssue {
  severity: 'error' | 'warning' | 'suggestion'
  message: string
  nodeIds: string[]
}

const SYSTEM_PROMPT = `你是 AIGC 工作流审查专家。用户会给你一个画布工作流（节点列表+连线），请找出其中潜在的问题。
重点检查：
1. 提示词问题：空泛/占位文本/与节点角色矛盾
2. 结构问题：无意义串联、冗余节点、断头路（生成节点产出没被任何下游或结果使用）
3. 参数矛盾：如 LLM 生成的尺寸参数接到不支持该端口的节点、重复设置同一参数
4. 模型链路问题：生成节点的 model 输入接的是不匹配类型的模型（文本模型接生图节点等）
5. 可用性问题：使用者用起来会困惑的配置（如必填输入没有来源）

只报告确实存在的问题，不要臆测。每个问题给出涉及的节点 id。最多报 6 条，按严重程度排序。
严格输出 JSON 数组（不要 markdown 代码块）：
[{"severity":"error|warning|suggestion","message":"不超过50字的中文问题描述","nodeIds":["节点id"]}]
没有问题就输出 []`

export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  }

  try {
    const { nodes, connections } = await request.json()
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return NextResponse.json({ success: false, message: '画布为空' }, { status: 400 })
    }
    const connList: CanvasConnLite[] = Array.isArray(connections) ? connections : []

    // 选模型统一走 model-catalog：口径与执行期/收费期一致（偏好名优先 + adapter 能力钩子校验），
    // 不再自己 findFirst 按 createdAt 撞任意一个历史模型。
    const model = await findDefaultModel('TEXT')
    if (!model || !model.provider?.apiKey) {
      return NextResponse.json({ success: false, message: '没有可用的文本模型' }, { status: 400 })
    }

    // 压缩上下文：节点（id/类型/label/关键输入）+ 连线
    const lines: string[] = [`节点(${nodes.length}):`]
    for (const n of nodes as CanvasNodeLite[]) {
      const keys = n.inputs ? Object.keys(n.inputs).slice(0, 8).join(',') : ''
      lines.push(`- ${n.id}「${n.label || n.type}」(${n.type}) 输入:${keys}`)
    }
    lines.push(`连线(${connList.length}):`)
    for (const c of connList.slice(0, 60)) {
      lines.push(`- ${c.sourceNodeId}.${c.sourcePort} → ${c.targetNodeId}.${c.targetPort}`)
    }

    let full = ''
    const apiKey = model.provider.apiKey
    await streamChatToUpstream(
      model.provider.baseUrl,
      apiKey,
      model.modelName,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: lines.join('\n') }],
        temperature: 0.2,
      },
      (chunk) => { full += chunk },
      undefined,
      { adapterId: model.provider.adapterId ?? undefined, configJson: (model.provider.configJson ?? null) as Record<string, unknown> | null },
      60000,
    )

    // 解析 JSON 数组（容忍 markdown 包裹）
    const m = full.match(/\[[\s\S]*\]/)
    if (!m) {
      return NextResponse.json({ success: true, data: { issues: [] } })
    }
    const parsed = JSON.parse(m[0]) as AiIssue[]
    const issues = parsed
      .filter((x) => x && typeof x.message === 'string')
      .slice(0, 6)
      .map((x) => ({
        severity: ['error', 'warning', 'suggestion'].includes(x.severity) ? x.severity : 'suggestion',
        message: String(x.message).slice(0, 100),
        nodeIds: Array.isArray(x.nodeIds) ? x.nodeIds.map(String).slice(0, 5) : [],
      }))
    return NextResponse.json({ success: true, data: { issues } })
  } catch {
    return NextResponse.json({ success: false, message: 'AI 检测失败' }, { status: 500 })
  }
}
