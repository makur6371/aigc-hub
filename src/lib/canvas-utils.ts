// 画布页纯逻辑（Q-803 已按职责拆分到 lib/canvas/）：
//   types.ts     数据契约        theme.ts     配色 / 文案映射
//   geometry.ts  尺寸与坐标计算   node-info.ts 端口能力与可见性
//   image.ts     前端图片压缩
// 本文件只做两件事：把拆出去的模块**原样转发**（调用方 import 路径不变），
// 以及承载剩下的零散工具（ID 生成、素材收集、演示拓扑/假输出）。

import type { CanvasNode } from './canvas/types'

export * from './canvas/types'
export * from './canvas/theme'
export * from './canvas/geometry'
export * from './canvas/image'
export * from './canvas/node-info'


export function generateId(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`
}


export function collectWorkflowAssets(
  nodes: CanvasNode[],
  logs: { nodeId: string; status: string; output?: Record<string, unknown> }[]
): { nodeId: string; role: 'input' | 'output'; url: string; label?: string }[] {
  const assets: { nodeId: string; role: 'input' | 'output'; url: string; label?: string }[] = []
  const seen = new Set<string>()
  const nodeLabel = (id: string) => nodes.find((n) => n.id === id)?.label

  logs.filter((l) => l.status === 'success' && l.output).forEach((log) => {
    const out = log.output!
    const label = nodeLabel(log.nodeId)
    const push = (url: unknown, suffix: string) => {
      const s = typeof url === 'string' ? url : ''
      if (!s.startsWith('http')) return
      const key = `${log.nodeId}-out-${suffix}`
      if (seen.has(key)) return
      seen.add(key)
      assets.push({ nodeId: log.nodeId, role: 'output', url: s, label })
    }
    push(out.imageUrl, 'imageUrl')
    push(out.image, 'image')
    if (Array.isArray(out.images)) out.images.forEach((u, i) => push(u, `arr${i}`))
  })

  const imgFields = ['image', 'imageUrl', 'imageA', 'imageB', 'referenceImage', 'imageInput']
  nodes.forEach((node) => {
    const ins = node.inputs || {}
    const label = node.label
    const push = (url: unknown, suffix: string) => {
      const s = typeof url === 'string' ? url : ''
      if (!s.startsWith('http')) return
      const key = `${node.id}-in-${suffix}`
      if (seen.has(key)) return
      seen.add(key)
      assets.push({ nodeId: node.id, role: 'input', url: s, label })
    }
    imgFields.forEach((f) => push(ins[f], f))
    if (Array.isArray(ins.image)) ins.image.forEach((u, i) => push(u, `arr${i}`))
  })

  return assets
}


// 演示模拟：简易拓扑排序（不依赖执行器，仅用于按依赖顺序展示假执行）
export function demoTopoSort(
  nodes: { id: string; type: string; label: string; category: string; x: number; y: number; inputs: Record<string, unknown>; outputs: Record<string, unknown> }[],
  conns: { sourceNodeId: string; targetNodeId: string }[]
): typeof nodes {
  const inDeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const nodeMap = new Map<string, typeof nodes[number]>()
  nodes.forEach((n) => { inDeg.set(n.id, 0); adj.set(n.id, []); nodeMap.set(n.id, n) })
  conns.forEach((c) => {
    if (adj.has(c.sourceNodeId) && inDeg.has(c.targetNodeId)) {
      adj.get(c.sourceNodeId)!.push(c.targetNodeId)
      inDeg.set(c.targetNodeId, inDeg.get(c.targetNodeId)! + 1)
    }
  })
  const q: string[] = []
  inDeg.forEach((d, id) => { if (d === 0) q.push(id) })
  const res: typeof nodes = []
  while (q.length) {
    const id = q.shift()!
    const n = nodeMap.get(id)
    if (n) res.push(n)
    ;(adj.get(id) || []).forEach((nx) => {
      inDeg.set(nx, inDeg.get(nx)! - 1)
      if (inDeg.get(nx) === 0) q.push(nx)
    })
  }
  return res
}


// 演示模拟：根据节点类型 + 输出素材生成假输出
export function genDemoOutput(
  node: { type: string; inputs: Record<string, unknown> },
  outAssets: { url: string }[]
): Record<string, unknown> {
  const url = outAssets.length ? outAssets[0].url : ''
  switch (node.type) {
    case 'image-generate':
    case 'nine-grid-loop':
    case 'image-preview':
    case 'image-upload':
      return { imageUrl: url || '/placeholder.png' }
    case 'grid9-to-gif':
      return { gifUrl: url || '/placeholder.png', frameUrls: [], frameCount: 0 }
    case 'image-crop':
      return { images: outAssets.map((a) => a.url).filter(Boolean) }
    case 'array-expand':
      return { items: Array.isArray(node.inputs.items) ? node.inputs.items : Array.isArray(node.inputs.images) ? node.inputs.images : [], images: Array.isArray(node.inputs.items) ? node.inputs.items : Array.isArray(node.inputs.images) ? node.inputs.images : [] }
    case 'json-parser': {
      const arr = Array.isArray(node.inputs.jsonInput) ? node.inputs.jsonInput : []
      return { items: arr, itemCount: arr.length }
    }
    case 'llm-chat':
      return { text: '（演示）这是模拟的 LLM 输出文本，用于展示节点运行效果。', tokens: 128 }
    case 'text-input':
    case 'text-preview':
      return { text: String(node.inputs.content ?? node.inputs.text ?? '') }
    case 'text-concat':
      return { result: [node.inputs.textA, node.inputs.textB].filter(Boolean).join(String(node.inputs.separator ?? '\n')) }
    case 'number-calc':
      return { result: 0 }
    case 'number-input':
      return { value: Number(node.inputs.value ?? 0) }
    case 'field-extractor':
      return { values: [], count: 0 }
    default:
      return url ? { imageUrl: url } : {}
  }
}
