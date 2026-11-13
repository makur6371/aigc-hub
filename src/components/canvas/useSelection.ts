'use client'

import { useState, useCallback } from 'react'

/**
 * 画布选择状态：单选节点(selectedNodeId) + 多选集合(selectedNodeIds) + 连线选中。
 * 收口此前散落在 4+ 处的"三连清空"重复逻辑，统一选中/取消语义。
 * 框选/Shift 多选的复杂语义与 drag 状态耦合，仍由 page 通过 setSelectedNodeIds 直接驱动。
 */
export function useSelection() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])

  const selectNode = useCallback((id: string) => {
    setSelectedNodeId(id)
    setSelectedNodeIds([id])
    setSelectedConnectionId(null)
  }, [])

  const selectConnection = useCallback((id: string) => {
    setSelectedConnectionId(id)
  }, [])

  const clearConnection = useCallback(() => {
    setSelectedConnectionId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedNodeId(null)
    setSelectedConnectionId(null)
    setSelectedNodeIds([])
  }, [])

  // 删除节点后修正：从多选集合移除，单选若指向被删节点则清空
  const deselectNodeIfRemoved = useCallback((removedIds: Set<string>) => {
    setSelectedNodeId((cur) => (cur && removedIds.has(cur) ? null : cur))
    setSelectedNodeIds((prev) => prev.filter((x) => !removedIds.has(x)))
  }, [])

  const deselectConnectionIfDeleted = useCallback((id: string) => {
    setSelectedConnectionId((cur) => (cur === id ? null : cur))
  }, [])

  return {
    selectedNodeId,
    selectedNodeIds,
    selectedConnectionId,
    setSelectedNodeIds,
    setSelectedNodeId,
    selectNode,
    selectConnection,
    clearConnection,
    clearSelection,
    deselectNodeIfRemoved,
    deselectConnectionIfDeleted,
  }
}
