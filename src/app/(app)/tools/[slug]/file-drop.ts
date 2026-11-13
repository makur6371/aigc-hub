'use client'

// 文件拖拽落点 hook（成果区 / 操作面板上传区各自独立使用）
//
// 从 tools/[slug]/page.tsx 抽出：这是一个自包含的拖拽 hook，与页面其余逻辑零耦合。
//
// 设计要点（原注释保留）：
// 为什么不用 React state 标记拖拽态、也不做全屏遮罩：本页中间是 iframe 工作台，
// 任何一次 setState 都会让整棵组件树重渲染；而 dragover 每几十毫秒触发一次，
// 配合全屏毛玻璃遮罩会直接把主线程拖死。所以拖拽高亮用 DOM class 直接切换（零 React 渲染），
// 深度计数去重，只有 drop 真正落文件时才回调。

import { useEffect, useRef } from 'react'

/**
 * 文件拖拽落点（成果区 / 操作面板上传区各自独立）。
 *
 * 为什么不用 React state 标记拖拽态、也不做全屏遮罩：
 * 本页中间是 iframe 工作台，任何一次 setState 都会让整棵组件树（成果列表 + iframe + 遮罩）
 * 重渲染；而 dragover 每几十毫秒触发一次，配合全屏毛玻璃遮罩会直接把主线程拖死
 * （用户实测「一拖拽就卡死，必须刷新」）。
 *
 * 所以这里：
 *   - 拖拽高亮用 DOM class 直接切换，**零 React 渲染**；
 *   - 深度计数去重，dragenter/dragleave 在子元素间反复触发也只改一次 class；
 *   - 只有 drop 真正落文件时才回调（那一次才需要更新列表）。
 */
/**
 * 站内成果图拖拽用的自定义 MIME。
 *
 * 为什么不用 text/uri-list 或 text/plain：那些是「拖出一段文本」的通用格式，
 * 浏览器/其它应用可能拦截或改写；自定义 MIME 只有我们自己认，
 * 落点据此区分「用户从本地拖进来的文件」和「站内拖动的成果图」两种拖拽。
 */
export const RESULT_DRAG_MIME = 'application/x-aigc-hub-result'

/** 拖拽载荷：一张成果图的基本信息 */
export type ResultDragPayload = { url: string; kind: 'image' | 'video' | 'audio'; label?: string }

export function useFileDrop(
  onFiles: (files: FileList) => void,
  opts?: {
    highlightClass?: string
    /**
     * 落点内若命中该选择器，则本次 drop 交给内部组件自己处理（不再回调）。
     *
     * 用途：操作面板里的 antd Dragger 上传框自带 drop 处理，面板层的落点若也处理，
     * 同一个文件会被上传两次。命中 Dragger 时直接放行。
     */
    skipSelector?: string
    /** 关闭该落点（例如工具没有上传槽时，面板不该显示「可拖入」高亮） */
    disabled?: boolean
    /**
     * 站内成果图拖到本落点时的处理（拖的是「一张已有的成果图」而不是本地文件）。
     * 不传则该落点只接受本地文件。
     */
    onResult?: (payload: ResultDragPayload) => void
  },
) {
  const highlightClass = opts?.highlightClass ?? 'aigc-hub-drop-active'
  const skipSelector = opts?.skipSelector
  const disabled = opts?.disabled ?? false
  const onResult = opts?.onResult
  const ref = useRef<HTMLDivElement>(null)
  const depthRef = useRef(0)
  const onFilesRef = useRef(onFiles)
  const onResultRef = useRef(onResult)

  // 「始终读最新回调」的 ref 必须在 **commit 之后**同步，不能在 render 期间写：
  // 渲染期写 ref 在并发渲染下不安全（React 编译器直接把这条判为 error）。
  // 时序上是等价的：下面注册的那些是 drag/drop 事件监听器，只可能由用户交互触发，
  // 必然发生在 commit 之后；而挂载时 `useRef(onFiles)` 已经拿到了首帧的值，不存在空窗。
  useEffect(() => {
    onFilesRef.current = onFiles
    onResultRef.current = onResult
  }, [onFiles, onResult])

  useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    /** 本地文件拖拽（含浏览器懒填充 types 为空的情况） */
    const isFileDrag = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (types.includes(RESULT_DRAG_MIME)) return false // 站内成果图不是文件
      // 拖拽刚进入时 types 可能还是空数组（浏览器懒填充），此时按文件拖拽处理
      return types.length === 0 || types.includes('Files')
    }
    /** 站内成果图拖拽 */
    const isResultDrag = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      return types.includes(RESULT_DRAG_MIME)
    }
    const isRelevant = (e: DragEvent) => {
      if (isResultDrag(e)) return !!onResultRef.current
      return isFileDrag(e)
    }
    const onEnter = (e: DragEvent) => {
      if (!isRelevant(e)) return
      e.preventDefault()
      e.stopPropagation()
      // 命中内部组件（如上传框）时不加整块高亮 —— 那里有自己的拖拽反馈，重复描边很吵
      if (skipSelector && (e.target as HTMLElement | null)?.closest?.(skipSelector)) return
      depthRef.current++
      if (depthRef.current === 1) el.classList.add(highlightClass)
    }
    const onOver = (e: DragEvent) => {
      if (!isRelevant(e)) return
      e.preventDefault()
      // drop 默认行为必须显式设置，否则部分浏览器会拒绝触发 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      e.stopPropagation()
      if (skipSelector && (e.target as HTMLElement | null)?.closest?.(skipSelector)) {
        // 移到上传框上：撤掉整块高亮，交给上传框自己的样式
        depthRef.current = 0
        el.classList.remove(highlightClass)
        return
      }
      // 兜底：某些浏览器首个事件是 dragover（没有 dragenter）
      if (depthRef.current === 0) { depthRef.current = 1; el.classList.add(highlightClass) }
    }
    const onLeave = (e: DragEvent) => {
      if (!isRelevant(e)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) el.classList.remove(highlightClass)
    }
    const onDrop = (e: DragEvent) => {
      if (!isRelevant(e)) return
      // 内部组件（如 antd Dragger）自己会处理这个落点，交给它，避免重复上传
      if (skipSelector && (e.target as HTMLElement | null)?.closest?.(skipSelector)) return
      e.preventDefault()
      e.stopPropagation()
      depthRef.current = 0
      el.classList.remove(highlightClass)
      // 站内成果图：读自定义 MIME 的 JSON 载荷
      if (isResultDrag(e)) {
        try {
          const raw = e.dataTransfer?.getData(RESULT_DRAG_MIME)
          if (raw) onResultRef.current?.(JSON.parse(raw) as ResultDragPayload)
        } catch { /* 载荷损坏：忽略 */ }
        return
      }
      const files = e.dataTransfer?.files
      if (files?.length) onFilesRef.current(files)
    }
    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onEnter)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [highlightClass, skipSelector, disabled])

  return ref
}
