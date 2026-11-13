// 节点信息 / 端口可见性（Q-803 自 canvas-utils 拆出）：
// 依据所选模型能力算出有效端口、连线该落到哪个输入口、哪些输入口在卡身上可见。

import type { CanvasNode, ExecutionLog, NodeInfo } from './types'

// 从 executionLogs 派生每个节点的最新状态
export function getNodeStatus(nodeId: string, logs: ExecutionLog[]): 'success' | 'error' | 'running' | 'idle' {
  const nodeLogs = logs.filter((l) => l.nodeId === nodeId)
  if (nodeLogs.length === 0) return 'idle'
  const last = nodeLogs[nodeLogs.length - 1]
  return last.status
}

// 根据节点所选模型的能力，计算有效端口（动态端口）
// llm-chat：选支持图的模型 → 追加 image 输入；选思考模型 → 追加 reasoning 输出
export function getEffectiveNodeInfo(
  node: CanvasNode,
  baseInfo: NodeInfo | undefined,
  modelOptions: { id: string; name: string; type: string; supportsVision: boolean; think: boolean; metadata?: Record<string, unknown> | null }[]
): NodeInfo | undefined {
  if (!baseInfo) return baseInfo

  const modelId = node.inputs.model as string | undefined
  const model = modelOptions.find((m) => m.id === modelId)
  const inputs = { ...baseInfo.inputs }
  const outputs = { ...baseInfo.outputs }

  if (node.type === 'llm-chat') {
    if (model?.supportsVision || model?.type === 'VISION') {
      inputs.image = { type: 'image', label: '参考图片', description: '可选，传入图片供模型读图' }
    }
    if (model?.think) {
      outputs.reasoning = { type: 'string', label: '思考过程', description: '模型的推理过程' }
    }
  } else if (node.type === 'image-generate') {
    const modes = Array.isArray(model?.metadata?.modes) ? model.metadata.modes as string[] : []
    if (modes.includes('singleImage') || modes.includes('multiReference')) {
      inputs.referenceImage = { type: 'image', label: '参考图片', description: '传入参考图供生图模型参考' }
    }
  } else if (node.type === 'video-generate') {
    // 模型 metadata 无特殊声明也放行 —— 视频模型的参考图能力由上游/adapter 决定，
    // 这里给出口子，adapter 负责把 referenceImages 映射成厂商字段。
    inputs.referenceImage = { type: 'image', label: '参考图片', description: '传入参考图供视频模型参考（多图参考生视频）' }
  }

  return { ...baseInfo, inputs, outputs }
}


// 每节点一进一出：输入取第一个可见 key，输出取第一个 key

// 每节点一进一出：输入取第一个可见 key，输出取第一个 key
export function primaryInputKey(nodeType: string, info?: NodeInfo): string | undefined {
  return visibleInputKeys(nodeType, info)[0]
}

export function primaryOutputKey(info?: NodeInfo): string | undefined {
  return info ? Object.keys(info.outputs)[0] : undefined
}


// 拖线落到节点上时，按源端口类型挑一个兼容的输入 key（image 源→参考图/图片口，string 源→prompt）

// 拖线落到节点上时，按源端口类型挑一个兼容的输入 key（image 源→参考图/图片口，string 源→prompt）
export function resolveTargetInputKey(
  srcPortType: string,
  info: NodeInfo | undefined,
  nodeType: string
): string | undefined {
  if (!info) return undefined
  const keys = visibleInputKeys(nodeType, info)
  if (keys.length === 0) return undefined
  const typeOf = (k: string) => info.inputs[k]?.type
  // 1) 完全同型优先
  const exact = keys.find((k) => typeOf(k) === srcPortType)
  if (exact) return exact
  // 2) 图片源：优先 referenceImage（生图），其次任意 image 口
  if (srcPortType === 'image') {
    const ref = keys.find((k) => k === 'referenceImage')
    if (ref) return ref
    const img = keys.find((k) => typeOf(k) === 'image')
    if (img) return img
    return keys[0]
  }
  // 3) string 源可强转到一切（canConnect 规则），prompt 优先
  if (srcPortType === 'string') {
    const prompt = keys.find((k) => k === 'prompt')
    if (prompt) return prompt
  }
  return keys[0]
}


// 面板专属参数：只在点击展开的参数面板编辑，不渲染为节点端口（与面板重复）

// 面板专属参数：只在点击展开的参数面板编辑，不渲染为节点端口（与面板重复）
export const PANEL_ONLY_INPUTS: Record<string, string[]> = {
  'image-generate': ['model', 'width', 'height', 'negativePrompt'],
  'nine-grid-loop': ['model', 'width', 'height', 'negativePrompt', 'outputMode'],
  'grid9-to-gif': ['delayMs', 'mode', 'frames', 'trimPercent', 'maxSize', 'background'],
  'video-generate': ['model', 'duration', 'aspectRatio', 'width', 'height'],
}

export function visibleInputKeys(nodeType: string, info?: NodeInfo): string[] {
  const keys = info ? Object.keys(info.inputs) : []
  const hidden = PANEL_ONLY_INPUTS[nodeType]
  const visible = hidden ? keys.filter((k) => !hidden.includes(k)) : keys
  // llm-chat：图片口提到首位——多图连线即引用是视觉 LLM 最主要的连线输入，展示球=图片口；
  // 文本源拖线时 resolveTargetInputKey 仍会精确校正回 prompt，互不冲突
  if (nodeType === 'llm-chat') {
    const imgKey = visible.find((k) => info?.inputs[k]?.type === 'image')
    if (imgKey) return [imgKey, ...visible.filter((k) => k !== imgKey)]
  }
  return visible
}


// 从节点输入图片 + 运行日志输出图片自动收集素材(供导出/演示使用)
