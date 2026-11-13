'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { CanvasNode, Connection, HistorySnapshot } from '@/lib/canvas-utils'
import { generateId } from '@/lib/canvas-utils'

/**
 * 画布复制粘贴剪贴板：copySelected 深拷贝选中节点+相关连线入剪贴板；
 * pasteClipboard 克隆剪贴板(新 id + 偏移)并交由 paste 回调加回画布。
 * 依赖通过 ref 镜像，copySelected/pasteClipboard 引用稳定。
 */
export function useClipboard({
  getSelectedNodeIds,
  getGraph,
  commitHistory,
  paste,
}: {
  getSelectedNodeIds: () => string[]
  getGraph: () => { nodes: CanvasNode[]; connections: Connection[] }
  commitHistory: () => void
  paste: (nodes: CanvasNode[], connections: Connection[], newIds: string[]) => void
}) {
  const [clipboard, setClipboard] = useState<HistorySnapshot | null>(null)
  const clipboardRef = useRef(clipboard)
  const getSelectedNodeIdsRef = useRef(getSelectedNodeIds)
  const getGraphRef = useRef(getGraph)
  const commitHistoryRef = useRef(commitHistory)
  const pasteRef = useRef(paste)

  // 最新值镜像到 ref：在 effect 里更新（渲染期写 ref 会触发 react-hooks/refs）。
  // 这些 ref 只被事件回调读取，effect 在提交后、任何用户事件前执行，无 stale 窗口。
  useEffect(() => {
    clipboardRef.current = clipboard
    getSelectedNodeIdsRef.current = getSelectedNodeIds
    getGraphRef.current = getGraph
    commitHistoryRef.current = commitHistory
    pasteRef.current = paste
  })

  const copySelected = useCallback(() => {
    const ids = getSelectedNodeIdsRef.current()
    if (ids.length === 0) return false
    const nodeSet = new Set(ids)
    const { nodes, connections } = getGraphRef.current()
    const copiedNodes = nodes
      .filter((n) => nodeSet.has(n.id))
      .map((n) => JSON.parse(JSON.stringify(n)) as CanvasNode)
    const copiedConns = connections
      .filter((c) => nodeSet.has(c.sourceNodeId) && nodeSet.has(c.targetNodeId))
      .map((c) => JSON.parse(JSON.stringify(c)) as Connection)
    setClipboard({ nodes: copiedNodes, connections: copiedConns })
    return true
  }, [])

  const pasteClipboard = useCallback(() => {
    const prev = clipboardRef.current
    if (!prev || prev.nodes.length === 0) return
    const idMap = new Map<string, string>()
    const clonedNodes = prev.nodes.map((n) => {
      const newId = generateId('node')
      idMap.set(n.id, newId)
      return { ...n, id: newId, x: n.x + 40, y: n.y + 40 }
    })
    const clonedConns = prev.connections
      .map((c) => ({
        ...c,
        id: generateId('conn'),
        sourceNodeId: idMap.get(c.sourceNodeId) || c.sourceNodeId,
        targetNodeId: idMap.get(c.targetNodeId) || c.targetNodeId,
      }))
      .filter((c) => idMap.has(c.sourceNodeId) && idMap.has(c.targetNodeId))
    commitHistoryRef.current()
    pasteRef.current(clonedNodes, clonedConns, clonedNodes.map((n) => n.id))
  }, [])

  return { clipboard, copySelected, pasteClipboard }
}
