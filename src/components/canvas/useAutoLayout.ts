import { useCallback } from 'react'
import { nodeWidthFor } from '@/lib/canvas-utils'

export type LayoutDirection = 'LR' | 'TB'
export type AlignType = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeDirection = 'horizontal' | 'vertical'

interface LayoutOptions {
  direction?: LayoutDirection
  nodeWidth?: number
  nodeHeight?: number
  gapX?: number
  gapY?: number
  /** 单列最多堆叠多少个节点，超出折到下一子列（避免 9 宫格这类宽层拉成一条长龙） */
  maxPerColumn?: number
}

interface LayoutResult {
  x: number
  y: number
}

/**
 * 排版用的高度兜底：端口估算对「多行文本」类节点明显偏小（textarea 会撑高卡片），
 * 这里给这些类型一个更保守的默认高度，避免排版后纵向重叠。
 * 实测高度可用时（heightFor 返回实测值）优先，不受此表影响。
 */
const MIN_HEIGHT_BY_TYPE: Record<string, number> = {
  'text-input': 220,
  'text-preview': 180,
  'llm-chat': 200,
  'json-parser': 180,
  'image-generate': 170,
  'image-preview': 180,
  'image-upload': 170,
  'image-upload-batch': 190,
  'video-generate': 180,
  'video-preview': 190,
  'audio-generate': 170,
}

/**
 * 自动排版 hook:基于拓扑排序的分层布局算法。
 * 无外部依赖,纯 JS 实现。支持 LR(左→右) 和 TB(上→下) 两个方向。
 *
 * 算法:
 * 1. 根据 connections 构建入度表
 * 2. Kahn 算法拓扑排序,按层分组(每层的节点入度为 0)
 * 3. 每层内按顺序排列,计算坐标
 * 4. 孤立节点(无连线)放到最后一层
 */
export function useAutoLayout(
  getNodePosition: (id: string) => { x: number; y: number },
  setNodePosition: (id: string, x: number, y: number) => void,
  getNodeHeight?: (id: string) => number,
  getNodeType?: (id: string) => string | undefined,
) {
  const autoLayout = useCallback((
    nodeIdsOrNodes: string[] | { id: string; type?: string; height?: number }[],
    connections: { sourceNodeId: string; targetNodeId: string }[],
    options: LayoutOptions = {},
  ): { id: string; x: number; y: number }[] => {
    // 兼容两种入参：纯 id 数组（旧调用，走 getter）或节点对象数组（导入时直接带 type/height）
    const isNodeList = nodeIdsOrNodes.length > 0 && typeof nodeIdsOrNodes[0] !== 'string'
    const nodeList = isNodeList ? (nodeIdsOrNodes as { id: string; type?: string; height?: number }[]) : []
    const nodeIds = isNodeList ? nodeList.map((n) => n.id) : (nodeIdsOrNodes as string[])
    const typeOf = (id: string) => (isNodeList ? nodeList.find((n) => n.id === id)?.type : getNodeType?.(id))
    const heightFor = (id: string) => {
      if (isNodeList) {
        const h = nodeList.find((n) => n.id === id)?.height
        if (typeof h === 'number' && h > 0) return h
      }
      const measured = getNodeHeight ? getNodeHeight(id) : nodeHeight
      const minH = MIN_HEIGHT_BY_TYPE[typeOf(id) ?? '']
      return minH ? Math.max(measured, minH) : measured
    }

    const {
      direction = 'LR',
      nodeWidth = 240,
      nodeHeight = 120,
      gapX = 80,
      gapY = 60,
      maxPerColumn = 6,
    } = options

    // 构建邻接表和入度
    const adj = new Map<string, string[]>()
    const inDeg = new Map<string, number>()
    for (const id of nodeIds) {
      adj.set(id, [])
      inDeg.set(id, 0)
    }
    for (const c of connections) {
      if (adj.has(c.sourceNodeId) && inDeg.has(c.targetNodeId)) {
        adj.get(c.sourceNodeId)!.push(c.targetNodeId)
        inDeg.set(c.targetNodeId, (inDeg.get(c.targetNodeId) || 0) + 1)
      }
    }

    // Kahn 拓扑排序,按层分组
    const layers: string[][] = []
    const queue: string[] = []
    const remaining = new Set(nodeIds)

    // 第一轮:入度为 0 的节点
    for (const id of nodeIds) {
      if (inDeg.get(id) === 0) {
        queue.push(id)
        remaining.delete(id)
      }
    }

    while (queue.length > 0) {
      const layer: string[] = []
      const nextQueue: string[] = []
      for (const id of queue) {
        layer.push(id)
        for (const next of adj.get(id) || []) {
          inDeg.set(next, (inDeg.get(next) || 0) - 1)
          if (inDeg.get(next) === 0 && remaining.has(next)) {
            nextQueue.push(next)
            remaining.delete(next)
          }
        }
      }
      layers.push(layer)
      queue.length = 0
      queue.push(...nextQueue)
    }

    // 剩余节点(有环或孤立)→单独成层，排在最右侧，避免混进主链末层
    const orphanIds: string[] = []
    if (remaining.size > 0) {
      orphanIds.push(...remaining)
    }

    // 空画布兜底
    if (layers.length === 0 && orphanIds.length === 0) return []

    // 排版结果：同时回填给调用方（导入时可先排版再一次性 setState，避免逐节点 setState 抖动）
    const positions: { id: string; x: number; y: number }[] = []
    const place = (id: string, x: number, y: number) => {
      positions.push({ id, x: Math.round(x), y: Math.round(y) })
      setNodePosition(id, Math.round(x), Math.round(y))
    }

    // 层内排序：同一上游的兄弟节点相邻排列，减少连线交叉
    const parentOf = new Map<string, string>()
    for (const c of connections) {
      if (!parentOf.has(c.targetNodeId)) parentOf.set(c.targetNodeId, c.sourceNodeId)
    }
    const sortWithinLayer = (layer: string[]) =>
      [...layer].sort((a, b) => {
        const pa = parentOf.get(a) ?? ''
        const pb = parentOf.get(b) ?? ''
        if (pa !== pb) return pa.localeCompare(pb)
        return nodeIds.indexOf(a) - nodeIds.indexOf(b)
      })

    // 计算坐标
    const baseX = 80
    const baseY = 80

    if (direction === 'LR') {
      // LR:按层分列；层内超高时折成多个子列（子列间用 gapX 分隔），避免一列过长
      let x = baseX
      const placeLayer = (layer: string[]) => {
        const sorted = sortWithinLayer(layer)
        const chunks: string[][] = []
        for (let i = 0; i < sorted.length; i += maxPerColumn) {
          chunks.push(sorted.slice(i, i + maxPerColumn))
        }
        let colX = x
        for (const chunk of chunks) {
          let y = baseY
          for (const nodeId of chunk) {
            const h = heightFor(nodeId)
            place(nodeId, colX, y)
            y += h + gapY
          }
          colX += Math.max(...chunk.map((id) => nodeWidthFor(typeOf(id))), nodeWidth) + gapX
        }
        x = colX
      }
      layers.forEach(placeLayer)
      if (orphanIds.length > 0) placeLayer(orphanIds)
    } else {
      // TB:按层分行,层内节点横向排列;行内按实际宽度累加(生成/媒体类 320 宽)
      let y = baseY
      const placeRow = (layer: string[]) => {
        let rowX = baseX
        let rowH = nodeHeight
        for (const nodeId of sortWithinLayer(layer)) {
          const w = nodeWidthFor(typeOf(nodeId)) || nodeWidth
          const h = heightFor(nodeId)
          place(nodeId, rowX, y)
          rowX += w + gapX
          rowH = Math.max(rowH, h)
        }
        y += rowH + gapY
      }
      layers.forEach(placeRow)
      if (orphanIds.length > 0) placeRow(orphanIds)
    }
    return positions
  }, [getNodePosition, setNodePosition, getNodeHeight, getNodeType])

  const resolveHeight = useCallback((id: string, defaultH = 120) => {
    const measured = getNodeHeight ? getNodeHeight(id) : defaultH
    const minH = MIN_HEIGHT_BY_TYPE[getNodeType?.(id) ?? '']
    return minH ? Math.max(measured, minH) : measured
  }, [getNodeHeight, getNodeType])

  /**
   * 多选节点对齐 (Align Nodes)
   * 支持 6 种对齐方式：左对齐、水平居中、右对齐、顶端对齐、垂直居中、底端对齐
   */
  const alignNodes = useCallback((nodeIds: string[], alignType: AlignType) => {
    if (nodeIds.length < 2) return
    const nodes = nodeIds.map((id) => {
      const pos = getNodePosition(id)
      const type = getNodeType?.(id)
      const w = nodeWidthFor(type)
      const h = resolveHeight(id)
      return { id, x: pos.x, y: pos.y, w, h }
    })

    const minX = Math.min(...nodes.map((n) => n.x))
    const maxX = Math.max(...nodes.map((n) => n.x + n.w))
    const minY = Math.min(...nodes.map((n) => n.y))
    const maxY = Math.max(...nodes.map((n) => n.y + n.h))
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    for (const n of nodes) {
      let nx = n.x
      let ny = n.y
      switch (alignType) {
        case 'left':
          nx = minX
          break
        case 'center':
          nx = centerX - n.w / 2
          break
        case 'right':
          nx = maxX - n.w
          break
        case 'top':
          ny = minY
          break
        case 'middle':
          ny = centerY - n.h / 2
          break
        case 'bottom':
          ny = maxY - n.h
          break
      }
      setNodePosition(n.id, Math.round(nx), Math.round(ny))
    }
  }, [getNodePosition, setNodePosition, getNodeType, resolveHeight])

  /**
   * 多选节点等间距分布 (Distribute Nodes)
   * 水平分布或垂直分布，至少需要 3 个节点
   */
  const distributeNodes = useCallback((nodeIds: string[], direction: DistributeDirection) => {
    if (nodeIds.length < 3) return
    const nodes = nodeIds.map((id) => {
      const pos = getNodePosition(id)
      const type = getNodeType?.(id)
      const w = nodeWidthFor(type)
      const h = resolveHeight(id)
      return { id, x: pos.x, y: pos.y, w, h }
    })

    if (direction === 'horizontal') {
      nodes.sort((a, b) => a.x - b.x)
      const minX = nodes[0].x
      const last = nodes[nodes.length - 1]
      const totalSpan = (last.x + last.w) - minX
      const totalW = nodes.reduce((sum, n) => sum + n.w, 0)
      const remainingSpace = totalSpan - totalW
      const gap = Math.max(30, remainingSpace / (nodes.length - 1))
      let curX = minX
      for (let i = 0; i < nodes.length; i++) {
        if (i > 0) {
          setNodePosition(nodes[i].id, Math.round(curX), nodes[i].y)
        }
        curX += nodes[i].w + gap
      }
    } else {
      nodes.sort((a, b) => a.y - b.y)
      const minY = nodes[0].y
      const last = nodes[nodes.length - 1]
      const totalSpan = (last.y + last.h) - minY
      const totalH = nodes.reduce((sum, n) => sum + n.h, 0)
      const remainingSpace = totalSpan - totalH
      const gap = Math.max(30, remainingSpace / (nodes.length - 1))
      let curY = minY
      for (let i = 0; i < nodes.length; i++) {
        if (i > 0) {
          setNodePosition(nodes[i].id, nodes[i].x, Math.round(curY))
        }
        curY += nodes[i].h + gap
      }
    }
  }, [getNodePosition, setNodePosition, getNodeType, resolveHeight])

  /**
   * 整理选中节点 (Tidy Selected Nodes)
   * 仅对选中节点及其内部连线执行 DAG 分层布局，保留选区的原有左上角锚点，不会跳回 (0,0)
   */
  const tidySelectedNodes = useCallback((
    nodeIds: string[],
    connections: { sourceNodeId: string; targetNodeId: string }[],
    options: LayoutOptions = {},
  ) => {
    if (nodeIds.length === 0) return []
    const origPositions = nodeIds.map((id) => getNodePosition(id))
    const origMinX = Math.min(...origPositions.map((p) => p.x))
    const origMinY = Math.min(...origPositions.map((p) => p.y))

    const idSet = new Set(nodeIds)
    const subConns = connections.filter((c) => idSet.has(c.sourceNodeId) && idSet.has(c.targetNodeId))

    const res = autoLayout(nodeIds, subConns, options)
    if (res.length === 0) return []

    const resMinX = Math.min(...res.map((r) => r.x))
    const resMinY = Math.min(...res.map((r) => r.y))
    const shiftX = origMinX - resMinX
    const shiftY = origMinY - resMinY

    return res.map((r) => {
      const finalX = Math.round(r.x + shiftX)
      const finalY = Math.round(r.y + shiftY)
      setNodePosition(r.id, finalX, finalY)
      return { id: r.id, x: finalX, y: finalY }
    })
  }, [autoLayout, getNodePosition, setNodePosition])

  return {
    autoLayout,
    alignNodes,
    distributeNodes,
    tidySelectedNodes,
  }
}
