'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { HistorySnapshot, StickyNote } from '@/lib/canvas-utils'

/**
 * 画布撤销/重做历史：维护 undoStack / redoStack（各最多 50 步快照）。
 * commitHistory 入栈当前画布快照（深拷贝）；undo 弹栈并把快照推入 redoStack；
 * redo 从 redoStack 弹栈恢复并推回 undoStack。
 * getSnapshot/restore 用 ref 镜像，引用稳定，调用方无需自行维护 ref 规避闭包过期。
 */

// 快照里超过 64KB 的内联图片替换为此标记：50 步历史 × 几 MB base64 会拖垮内存与 JSON 序列化
const IMG_STRIPPED = '__IMG_STIPPED__'
const IMG_SNAPSHOT_LIMIT = 64 * 1024

function stripHeavyImages(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('data:image') && value.length > IMG_SNAPSHOT_LIMIT ? IMG_STRIPPED : value
  }
  if (Array.isArray(value)) return value.map(stripHeavyImages)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = stripHeavyImages(v)
    return out
  }
  return value
}
export function useCanvasHistory({
  getSnapshot,
  restore,
}: {
  getSnapshot: () => { nodes: HistorySnapshot['nodes']; connections: HistorySnapshot['connections']; stickyNotes?: StickyNote[] }
  restore: (snap: HistorySnapshot) => void
}) {
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([])
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([])

  const getSnapshotRef = useRef(getSnapshot)
  const restoreRef = useRef(restore)

  // 最新值镜像到 ref：在 effect 里更新（渲染期写 ref 会触发 react-hooks/refs）
  useEffect(() => {
    getSnapshotRef.current = getSnapshot
    restoreRef.current = restore
  })

  const commitHistory = useCallback(() => {
    setUndoStack((prev) => {
      const cur = getSnapshotRef.current()
      const snap: HistorySnapshot = {
        nodes: JSON.parse(JSON.stringify(stripHeavyImages(cur.nodes))) as HistorySnapshot['nodes'],
        connections: JSON.parse(JSON.stringify(cur.connections)),
      }
      if (cur.stickyNotes) {
        snap.stickyNotes = JSON.parse(JSON.stringify(cur.stickyNotes))
      }
      const next = [...prev, snap]
      return next.length > 50 ? next.slice(next.length - 50) : next
    })
    // 新操作后清空重做栈（避免在已回退的旧分支上重做）
    setRedoStack([])
  }, [])

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      restoreRef.current(last)
      // 撤销的快照推入 redo 栈，供 redo 恢复
      setRedoStack((r) => (r.length >= 50 ? [...r.slice(r.length - 49), last] : [...r, last]))
      return prev.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      restoreRef.current(last)
      // 重做后推回 undo 栈，保持撤销链连续
      setUndoStack((u) => (u.length >= 50 ? [...u.slice(u.length - 49), last] : [...u, last]))
      return prev.slice(0, -1)
    })
  }, [])

  return { undoStack, redoStack, commitHistory, undo, redo }
}
