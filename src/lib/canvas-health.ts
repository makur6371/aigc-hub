import { canConnect } from './connection-compat'

// 画布拓扑健康检查:给 Copilot 提供确定性的校验结果(而非让 LLM 猜)
// 检查项:连线端口存在性、端口类型兼容、必填输入、LLM/生图节点模型选择

export interface HealthNode {
  id: string
  type: string
  label?: string
  inputs: Record<string, unknown>
}

export interface HealthConnection {
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
}

export interface HealthPortInfo {
  type?: string
  required?: boolean
  label?: string
}

export interface HealthNodeInfo {
  inputs: Record<string, HealthPortInfo>
  outputs: Record<string, HealthPortInfo>
}

export interface HealthIssue {
  severity: 'error' | 'warning'
  message: string
}

export interface HealthCheckResult {
  issues: HealthIssue[]
  summary: string
}

const MAX_ISSUES_SHOWN = 8

export function checkCanvasHealth(
  nodes: HealthNode[],
  connections: HealthConnection[],
  getNodeInfo: (node: HealthNode) => HealthNodeInfo | undefined
): HealthCheckResult {
  const issues: HealthIssue[] = []
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const label = (n?: HealthNode) => (n?.label ? n.label : n?.id.slice(-6) || '?')

  // 每个节点已连接的输入端口集合(必填输入检查用)
  const incomingMap = new Map<string, Set<string>>()
  for (const c of connections) {
    if (!incomingMap.has(c.targetNodeId)) incomingMap.set(c.targetNodeId, new Set())
    incomingMap.get(c.targetNodeId)!.add(c.targetPort)
  }

  // 连线检查
  for (const c of connections) {
    const src = nodeById.get(c.sourceNodeId)
    const tgt = nodeById.get(c.targetNodeId)
    if (!src) { issues.push({ severity: 'error', message: `连线源节点不存在: ${c.sourceNodeId.slice(-6)}` }); continue }
    if (!tgt) { issues.push({ severity: 'error', message: `连线目标节点不存在: ${c.targetNodeId.slice(-6)}` }); continue }
    const srcPort = getNodeInfo(src)?.outputs?.[c.sourcePort]
    const tgtPort = getNodeInfo(tgt)?.inputs?.[c.targetPort]
    if (!srcPort) issues.push({ severity: 'error', message: `「${label(src)}」的输出端口 ${c.sourcePort} 不存在` })
    if (!tgtPort) issues.push({ severity: 'error', message: `「${label(tgt)}」的输入端口 ${c.targetPort} 不存在` })
    if (srcPort && tgtPort && !canConnect(srcPort.type, tgtPort.type)) {
      issues.push({
        severity: 'error',
        message: `端口类型不匹配: 「${label(src)}」.${c.sourcePort}(${srcPort.type}) → 「${label(tgt)}」.${c.targetPort}(${tgtPort.type})`,
      })
    }
  }

  // 节点检查
  for (const n of nodes) {
    const info = getNodeInfo(n)
    if (!info) continue // 未知类型(自定义)跳过
    const incoming = incomingMap.get(n.id)
    for (const [key, port] of Object.entries(info.inputs)) {
      if (!port.required) continue
      const val = n.inputs[key]
      const missing = val === undefined || val === null || val === ''
      if (missing && !incoming?.has(key)) {
        issues.push({ severity: 'error', message: `「${label(n)}」缺少必填输入 ${port.label || key}(${key})` })
      }
    }
    if ((n.type === 'llm-chat' || n.type === 'image-generate' || n.type === 'nine-grid-loop') && !n.inputs.model) {
      issues.push({ severity: 'warning', message: `「${label(n)}」未选择模型` })
    }
  }

  // 摘要(截断防上下文溢出)
  const errCount = issues.filter((i) => i.severity === 'error').length
  const warnCount = issues.filter((i) => i.severity === 'warning').length
  let summary: string
  if (issues.length === 0) {
    summary = '画布健康检查: 通过(0 问题)'
  } else {
    const shown = issues.slice(0, MAX_ISSUES_SHOWN)
    const rest = issues.length - shown.length
    summary = `画布健康检查: ${errCount} 错误 / ${warnCount} 警告\n` +
      shown.map((i) => `- [${i.severity === 'error' ? '错误' : '警告'}] ${i.message}`).join('\n') +
      (rest > 0 ? `\n(+${rest} 条更多问题)` : '')
  }

  return { issues, summary }
}
