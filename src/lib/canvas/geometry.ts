import { visibleInputKeys } from './node-info'
// 画布几何（Q-803 拆出）：尺寸常量、坐标计算、连线贝塞尔、端口定位 —— 只依赖类型。

import type { NodeInfo } from './types'
import { RESULT_CARD_TYPES } from './theme'


// 几何常量
export const NODE_WIDTH = 240

export const NODE_HEADER_HEIGHT = 36

export const NODE_PORT_HEIGHT = 26

export const NODE_PADDING = 8

export const MIN_SCALE = 0.25

export const MAX_SCALE = 3

export const GRID_SIZE = 20


// 生成/媒体类节点加宽（上参数条+下输入框需要横向空间），其余保持 240
export const NODE_WIDTH_BY_TYPE: Record<string, number> = {
  'llm-chat': 320,
  'image-generate': 320,
  'nine-grid-loop': 320,
  'grid9-to-gif': 320,
  'image-upload': 320,
  'image-upload-batch': 320,
  'image-preview': 320,
  'image-crop': 320,
  'face-doodle': 320,
  'video-generate': 320,
  'video-preview': 320,
  'audio-generate': 320,
  'music-generate': 320,
  'tts-generate': 320,
  'sfx-generate': 320,
  'voice-isolate': 320,
  'audio-upload': 320,
  'transcribe': 320,
  'ocr': 300,
}

export function nodeWidthFor(nodeType?: string): number {
  return (nodeType && NODE_WIDTH_BY_TYPE[nodeType]) || NODE_WIDTH
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function snap(value: number, step: number) {
  return Math.round(value / step) * step
}

export function getPortPosition(
  node: { x: number; y: number },
  _portKey: string,
  side: 'input' | 'output',
  info: NodeInfo | undefined,
  nodeType?: string,
  nodeHeight?: number
): { x: number; y: number } {
  // 端口悬浮化后每节点只有一进一出两颗球，固定在节点左右边缘垂直中线；
  // 旧多端口连线的 key 仍保留在协议里（resolveInputs 按 targetPort 写入），只是 UI 汇聚同一点。
  // 球心实测校准（DOM 量测，translate 动画已移除后）：输入球心 = 卡左缘 +3，输出球心 = 卡右缘 -3；
  // y = 卡顶 + 卡高/2 + 3（border 与 port 定位的合成偏移）
  const bodyH = nodeHeight ?? estimateNodeHeight(info, visibleInputKeys(nodeType ?? '', info).length, info ? Object.keys(info.outputs).length : 1, nodeType)
  const noHeader = !!nodeType && RESULT_CARD_TYPES.includes(nodeType)
  const w = nodeWidthFor(nodeType)
  const portY = noHeader
    ? Math.max(NODE_PADDING, bodyH / 2)
    : NODE_HEADER_HEIGHT + Math.max(NODE_PADDING, (bodyH - NODE_HEADER_HEIGHT) / 2)
  return {
    x: side === 'input' ? node.x + 3 : node.x + w - 3,
    y: node.y + portY + 3,
  }
}


// 卡片高度：按可见端口数算（panel-only 参数不占端口行），避免节点底部留白
export function estimateNodeHeight(
  nodeInfo: NodeInfo | undefined,
  visibleInputCount?: number,
  visibleOutputCount?: number,
  nodeType?: string
): number {
  if (!nodeInfo) return NODE_HEADER_HEIGHT + NODE_PADDING * 2
  // 可见端口数优先（panel-only 参数不占端口行）；未传则按全部端口
  const inputCount = visibleInputCount ?? Object.keys(nodeInfo.inputs).length
  const outputCount = visibleOutputCount ?? Object.keys(nodeInfo.outputs).length
  const maxPorts = Math.max(inputCount, outputCount, 1)
  // 结果卡身节点无标题条 → 高度即卡身高度；表单类含 header
  const noHeader = !!nodeType && RESULT_CARD_TYPES.includes(nodeType)
  return (noHeader ? 0 : NODE_HEADER_HEIGHT) + NODE_PADDING * 2 + maxPorts * NODE_PORT_HEIGHT
}

export function getBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5
  const c1x = x1 + dx
  const c2x = x2 - dx
  return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
}
