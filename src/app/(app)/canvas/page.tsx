'use client'

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react'
import { notify } from '@/lib/browser-notify'
import { consumeSseStream } from '@/lib/sse'
import type { ExecutionEvent as CanvasSseEvent } from '@/lib/canvas-executor'

import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import {
  Card,
  Typography,
  Tag,
  Tooltip,
  Button,
  Input,
  Select,
  Switch,
  InputNumber,
  Upload,
  message,
  Space,
  Image,
  Modal,
  Menu,
  Segmented,
  Popconfirm,
  Dropdown,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  ThunderboltOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SoundOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  ImportOutlined,
  CloseOutlined,
  DeleteOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  FullscreenOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  FolderOpenOutlined,
  StarOutlined,
  BookOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MenuOutlined,
  AppstoreOutlined,
  ScissorOutlined,
  QuestionCircleOutlined,
  CopyOutlined,
  CheckOutlined,
  SearchOutlined,
  PartitionOutlined,
  DownloadOutlined,
  UndoOutlined,
  ExportOutlined,
  StopOutlined,
  ClearOutlined,
  RobotOutlined,
  ArrowLeftOutlined,
  ExpandOutlined,
  EditOutlined,
  ToolOutlined,
  FileTextOutlined,
  RedoOutlined,
  AlignLeftOutlined,
  AlignCenterOutlined,
  AlignRightOutlined,
  VerticalAlignTopOutlined,
  VerticalAlignMiddleOutlined,
  VerticalAlignBottomOutlined,
  ColumnWidthOutlined,
  ColumnHeightOutlined,
  SmileOutlined,
  EyeOutlined,
  RetweetOutlined,
} from '@ant-design/icons'
import { useAutoLayout, type AlignType, type DistributeDirection } from '@/components/canvas/useAutoLayout'
import { useNodeRegistry } from '@/components/canvas/useNodeRegistry'
import { useSelection } from '@/components/canvas/useSelection'
import { useCanvasHistory } from '@/components/canvas/useCanvasHistory'
import { useClipboard } from '@/components/canvas/useClipboard'
import { parsePromptBlocks } from '@/lib/json-blocks'
import { canConnect } from '@/lib/connection-compat'
import { checkCanvasHealth } from '@/lib/canvas-health'
import type { UploadFile } from 'antd/es/upload'

import { CopilotPanel } from '@/components/canvas/CopilotPanel'
import { CatalogPanel } from '@/components/canvas/CatalogPanel'
import { PublishToolWizard } from '@/components/canvas/PublishToolWizard'
import { ThunderboltFilled } from '@ant-design/icons'
import { AnimatedLogo } from '@/components/ui/AnimatedLogo'
import { Minimap, NodeDocsModal } from '@/components/canvas/canvas-widgets'
import type { WorkflowTool } from '@/app/(app)/canvas/tool-types'
import { PRESET_TEMPLATES, TOOL_TEMPLATES, type PresetTemplate } from '@/app/(app)/canvas/preset-templates'
import { enqueueImage, isImageFileTooLarge, renderInputField } from '@/app/(app)/canvas/page-fields'
import { apiFetch } from '@/lib/api-client'
import type { StickyNote } from '@/lib/canvas-utils'
import { PromptEditor, RefThumb } from '@/components/canvas/PromptEditor'
import { CropWorkbench } from '@/components/canvas/CropWorkbench'
import { FaceDoodleWorkbench } from '@/components/canvas/FaceDoodleWorkbench'
import { dispatchNodeBody, dispatchParamBar, dispatchPromptPanel, hasResultCard, TextResult, type NodeBodyCtx } from '@/components/canvas/node-bodies'
import { getImageCapabilities } from '@/lib/image-sizes'
import { emitWorkflowExecuted } from '@/components/canvas/copilot-events'
import { SecurityBanner } from '@/components/auth/SecurityBanner'
import { FirstUseGuide, GUIDE_STEPS } from '@/components/ui/FirstUseGuide'
import { StatusTag } from '@/components/ui/StatusTag'
import { Loading } from '@/components/ui/Loading'
import { PageState } from '@/components/ui/PageState'
import {
  NODE_WIDTH,
  NODE_HEADER_HEIGHT,
  NODE_PORT_HEIGHT,
  NODE_PADDING,
  MIN_SCALE,
  MAX_SCALE,
  GRID_SIZE,
  categoryLabels,
  statusColors,
  typeColors,
  categoryColors,
  generateId,
  clamp,
  snap,
  getNodeStatus,
  getEffectiveNodeInfo,
  getPortPosition,
  visibleInputKeys,
  estimateNodeHeight,
  nodeWidthFor,
  resolveTargetInputKey,
  compressImageDataUrl,
  getBezierPath,
  collectWorkflowAssets,
  demoTopoSort,
  genDemoOutput,
  type NodeInfo,
  type NodePort,
  type CanvasNode,
  type Connection,
  type Viewport,
  type DragState,
  type HistorySnapshot,
  type ExecutionLog,
  type WorkflowItem,
} from '@/lib/canvas-utils'
import { batchCopyPosition, batchLayoutForHeight } from '@/lib/canvas-batch'
import { MediaPreviewModals } from '@/components/canvas/MediaPreviewModals'
import { WorkflowSaveModal } from '@/components/canvas/WorkflowSaveModal'
import { readLocalText, writeLocalJson, removeLocalKey } from '@/lib/local-store'
import { CanvasNodeCard } from '@/components/canvas/CanvasNodeCard'
import { categoryIcons } from '@/components/canvas/canvas-node-meta'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

// 空态引导示例：点击预填给 Copilot，打开面板
const EMPTY_PROMPTS = [
  '搭一个"海报设计"工作流',
  '用一张参考图生成同风格图片',
  '批量给 5 张图加文字排版',
  '做一个"文生图→视频"的流水线',
  '对图片做四宫格裁切并逐格放大',
]


// ------------------------------------------------------------------
// Components
// ------------------------------------------------------------------

export default function CanvasPage() {
  const router = useRouter()

  // 工具箱「在画布中编辑」（Remix）：URL 带 ?load=tool:<id> 时载入工具快照
  const toolLoadRef = useRef(false)
  const [remixToolId, setRemixToolId] = useState<string | undefined>(undefined)
  // ===== 提前声明的状态/工具函数（供上方 effect 与事件处理引用，避免「变量在声明前被访问」）=====
  const [workflowName, setWorkflowName] = useState('')
  // 参数面板开关：只有「点击」节点（pointerup 无位移）才展开，拖拽/连线不触发
  const [panelOpenNodeId, setPanelOpenNodeId] = useState<string | null>(null)
  // 该类型是否已有内联卡身（无旧面板）
  const hasInlineBody = (type: string) => hasResultCard(type)
  useEffect(() => {
    if (toolLoadRef.current) return
    const params = new URLSearchParams(window.location.search)
    const loadId = params.get('load')
    if (!loadId?.startsWith('tool:')) return
    toolLoadRef.current = true
    const toolId = loadId.slice(5)
    void (async () => {
      try {
        const res = await fetch(`/api/tools/${toolId}`)
        const j = await res.json()
        if (!j?.success || !j.data) { return }
        const wf = j.data.workflow as { nodes?: CanvasNode[]; connections?: Connection[] } | null
        if (wf?.nodes?.length) {
          setRemixToolId(toolId)
          setWorkflowName(j.data.name || '')
          // setTimeout 退出 effect 同步栈，避免 TDZ（animateLoadNodes 在组件尾部声明）
          setTimeout(() => {
            void (async () => {
              await animateLoadNodes(wf.nodes as CanvasNode[], (wf.connections ?? []) as Connection[])
              message.success(`已载入工具「${j.data.name}」快照，改完可「存为工具」发布新版本`)
            })()
          }, 0)
        }
      } catch { /* 载入失败静默 */ }
    })()
  }, [])
  const canvasRef = useRef<HTMLDivElement>(null)
  // 画布容器实测尺寸/位置（渲染期读 ref 会触发 react-hooks/refs，改为 state 跟随）
  const [canvasBox, setCanvasBox] = useState({ left: 0, top: 0, width: 0, height: 0 })
  // 自动排版 / 视口适配的 ref 桥：animateLoadNodes 声明在 autoLayout/fitView 之前，
  // 直接用会 TDZ；用 ref 在两者定义后回填，载入时通过 ref 调用
  const autoLayoutRef = useRef<((nodes: CanvasNode[], conns: Connection[]) => { id: string; x: number; y: number }[]) | null>(null)
  const fitViewRef = useRef<(() => void) | null>(null)
  // 撤销历史 / 批量展开：声明在下方（依赖大量画布状态），上方回调通过 ref 调用绕开「变量在声明前被访问」
  const commitHistoryRef = useRef<() => void>(() => {})
  const expandBatchNodeRef = useRef<(batchNodeId: string, trigger?: { targetNodeId: string; targetPort: string }) => void>(() => {})
  const { nodes, groupedNodes, modelOptions, nodeInfoMap, modelsLoading } = useNodeRegistry()
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  // 每次渲染同步最新画布状态到 ref,供 Copilot 健康检查等 stale 闭包读取
  const canvasStateRef = useRef({ nodes: canvasNodes, connections })
  // 拖线松手未命中输入端口时，记录待连线的源端口与落点，供「节点库选节点后自动连线」
  const pendingConnectRef = useRef<{ sourceNodeId: string; sourcePort: string; x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [drag, setDrag] = useState<DragState>({ type: 'idle' })
  // 镜像 drag/viewport/canvasNodes 到 ref：window pointer 监听只注册一次，读 ref 避免闭包空窗期丢 move
  const dragRef = useRef(drag)
  const viewportRef = useRef(viewport)
  const canvasNodesRef = useRef(canvasNodes)
  // 触控多点追踪:活动指针(用于双指捏合) + 发起拖拽的指针 id + 捏合起始状态
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const dragPointerIdRef = useRef<number | null>(null)
  const pinchRef = useRef<{ startDist: number; startScale: number; midX: number; midY: number } | null>(null)
  // 双击缩放追踪 + 节点右键/长按菜单
  const lastTapRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  // 长按弹菜单后，紧随其后的 pointerup/click 会立刻点掉菜单；用时间戳抑制这次关闭
  const nodeMenuSuppressCloseRef = useRef(0)
  // 点按添加后 catalog 折叠、布局左移，紧随的 click 会误触折叠区类别图标/折叠按钮 → 抑制窗口
  const {
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
  } = useSelection()
  // 框选矩形(世界坐标)
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // 加载工作流/官方工作流的进度提示
  const [loadMsg, setLoadMsg] = useState<string>('')
  const [logsCollapsed, setLogsCollapsed] = useState(true)
  // Minimap：工具栏按钮控制（悬停预览 / 点击固定）
  const [minimapPinned, setMinimapPinned] = useState(false)
  const [minimapHover, setMinimapHover] = useState(false)
  const [cropWorkbenchNodeId, setCropWorkbenchNodeId] = useState<string | null>(null)
  const [doodleWorkbenchNodeId, setDoodleWorkbenchNodeId] = useState<string | null>(null)
  const [nodeDocsOpen, setNodeDocsOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // 空态引导：示例 prompt 点击后传给 Copilot 打开并预填
  const [copilotExternalPrompt, setCopilotExternalPrompt] = useState<string | null>(null)
  // 首页入口动画进入时自动执行任务
  const [copilotAutoRun, setCopilotAutoRun] = useState(false)
  // Copilot 改动节点的画布高亮(3s 自动清除)
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Copilot 计划幽灵预览(批准前以虚线呈现规划的节点/连线)
  const [ghostState, setGhostState] = useState<{ nodes: { id: string; nodeType: string }[]; connections: { sourceId: string; sourcePort: string; targetId: string; targetPort: string }[] } | null>(null)

  // 画布便签：独立于 DAG 拓扑，不入执行、只做创作辅助注释
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([])
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const stickyNotesRef = useRef<StickyNote[]>([])
  useEffect(() => {
    stickyNotesRef.current = stickyNotes
  })

  const addStickyNote = useCallback((worldX?: number, worldY?: number) => {
    commitHistoryRef.current()
    const rc = canvasRef.current?.getBoundingClientRect()
    const v = viewportRef.current
    const cx = worldX ?? (rc ? (rc.width / 2 - v.x) / v.scale : 200)
    const cy = worldY ?? (rc ? (rc.height / 2 - v.y) / v.scale : 200)
    const colors = ['yellow', 'pink', 'blue', 'green', 'orange'] as const
    const note: StickyNote = {
      id: generateId('note'),
      x: snap(cx - 100, GRID_SIZE),
      y: snap(cy - 70, GRID_SIZE),
      width: 200,
      height: 140,
      text: '',
      color: colors[stickyNotesRef.current.length % colors.length],
      createdAt: Date.now(),
    }
    setStickyNotes((prev) => [...prev, note])
    setEditingNoteId(note.id)
  }, [])

  const updateStickyNote = useCallback((id: string, patch: Partial<StickyNote>) => {
    setStickyNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  const deleteStickyNote = useCallback((id: string) => {
    commitHistoryRef.current()
    setStickyNotes((prev) => prev.filter((n) => n.id !== id))
    setEditingNoteId((cur) => (cur === id ? null : cur))
  }, [])


  // Execution state
  const [running, setRunning] = useState(false)
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([])
  const [executionError, setExecutionError] = useState<string | null>(null)
  const executionLogsRef = useRef(executionLogs)
  const abortRef = useRef<AbortController | null>(null)
  // ===== 最新值镜像到 ref =====
  // 这些 ref 供「只注册一次的 window 监听」与 stale 闭包读取，必须在每次提交后同步。
  // 在 effect 里更新（渲染期写 ref 会触发 react-hooks/refs）。
  useEffect(() => {
    canvasStateRef.current = { nodes: canvasNodes, connections }
    dragRef.current = drag
    viewportRef.current = viewport
    canvasNodesRef.current = canvasNodes
    executionLogsRef.current = executionLogs
  })

  // Workflow persistence state
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([])
  const [publishToolOpen, setPublishToolOpen] = useState(false)
  // 存为工具时用最近一次运行产出的末张图作为默认封面
  const [publishCover, setPublishCover] = useState<string | undefined>(undefined)
  // 节点内图片/视频点击放大预览（Lightbox）
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [previewCompareImage, setPreviewCompareImage] = useState<string | null>(null)
  const [previewVideo, setPreviewVideo] = useState<string | null>(null)
  // 智能解析放大的节点是否存在对比原图（上游参考图 / 裁切涂鸦前原图）
  const handlePreviewImageWithCompare = useCallback((targetUrl: string) => {
    let matchedNode: CanvasNode | undefined
    for (const n of canvasNodes) {
      const log = executionLogs.find((l) => l.nodeId === n.id && l.status === 'success')
      const out = log?.output as Record<string, unknown> | undefined
      if (out?.imageUrl === targetUrl || (Array.isArray(out?.images) && out?.images.includes(targetUrl))) {
        matchedNode = n
        break
      }
    }

    let compSrc: string | null = null
    if (matchedNode) {
      // 如果是漫改涂鸦或裁切节点，原图取自身 imageUrl 输入或上游连线
      if (matchedNode.type === 'face-doodle' || matchedNode.type === 'image-crop') {
        const ownUrl = String(matchedNode.inputs.image ?? matchedNode.inputs.imageUrl ?? '')
        if (ownUrl && ownUrl !== targetUrl) compSrc = ownUrl
      }
      // 如果是生图节点，查找连到 referenceImage 的上游图片
      if (!compSrc && (matchedNode.type === 'image-generate' || matchedNode.type === 'nine-grid-loop')) {
        const refConns = connections.filter((c) => c.targetNodeId === matchedNode!.id && (c.targetPort === 'referenceImage' || c.targetPort === 'image'))
        for (const conn of refConns) {
          const upLog = executionLogs.find((l) => l.nodeId === conn.sourceNodeId && l.status === 'success')
          const upOut = upLog?.output as Record<string, unknown> | undefined
          if (upOut?.imageUrl) { compSrc = String(upOut.imageUrl); break }
          if (Array.isArray(upOut?.images) && upOut.images[0]) { compSrc = String(upOut.images[0]); break }
          const upNode = canvasNodes.find((n) => n.id === conn.sourceNodeId)
          if (upNode) {
            const cand = String(upNode.inputs.image ?? upNode.inputs.imageUrl ?? '')
            if (cand && cand !== targetUrl) { compSrc = cand; break }
          }
        }
      }
    }

    setPreviewCompareImage(compSrc)
    setPreviewImage(targetUrl)
  }, [canvasNodes, connections, executionLogs])

  const [savingWorkflow, setSavingWorkflow] = useState(false)
  const [workflowModalOpen, setWorkflowModalOpen] = useState(false)
  const [demoAssets, setDemoAssets] = useState<{ nodeId: string; role: 'input' | 'output'; url: string; label?: string }[]>([])
  // 左侧面板双模式：节点库（创作）/ 工作流库（直接使用）；默认收起，悬停工具栏按钮展开、点击固定
  const [catalogMode, setCatalogMode] = useState<'nodes' | 'workflows' | 'presets' | 'tools'>('nodes')
  const [catalogPinned, setCatalogPinned] = useState(false)
  const [catalogHover, setCatalogHover] = useState(false)
  const catalogOpen = catalogPinned || catalogHover
  const catalogHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const catalogHoverOpen = () => { if (catalogHoverTimerRef.current) { clearTimeout(catalogHoverTimerRef.current); catalogHoverTimerRef.current = null } ; setCatalogHover(true) }
  const catalogHoverClose = () => { if (catalogHoverTimerRef.current) clearTimeout(catalogHoverTimerRef.current); catalogHoverTimerRef.current = setTimeout(() => setCatalogHover(false), 250) }

  // 三库按钮 ref + 面板锚点：CatalogPanel 用 createPortal 渲染到 body，需取按钮的屏幕坐标定位下拉面板
  const catalogAnchorRefs = useRef<Record<'nodes' | 'presets' | 'tools', HTMLButtonElement | null>>({ nodes: null, presets: null, tools: null })
  const [catalogAnchorRect, setCatalogAnchorRect] = useState<DOMRect | null>(null)
  const captureCatalogAnchor = (mode: 'nodes' | 'presets' | 'tools') => {
    setCatalogAnchorRect(catalogAnchorRefs.current[mode]?.getBoundingClientRect() ?? null)
  }
  // 收藏分类关闭时清空锚点，避免残留定位
  const closeCatalog = useCallback(() => {
    setCatalogHover(false)
    setCatalogPinned(false)
    setCatalogAnchorRect(null)
  }, [])

  // 双击画布空白 → 就近弹出节点选择面板（跟随双击位置，复用 CatalogPanel quickPicker 模式：两级 hover 级联）
  const [quickPicker, setQuickPicker] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null)

  // 双击画布空白：在双击位置就近弹出「节点选择面板」，选中后自动在该点落节点
  const handleCanvasBackgroundDoubleClick = (e: React.MouseEvent) => {
    if (quickPicker) { closeQuickPicker(); return } // 已开着再双击 → 关闭
    // 双击节点（卡身/头部/端口）不弹面板——那是节点自己的双击语义，冒泡到画布会被误当成「双击空白」
    const t = e.target as HTMLElement
    if (t.closest('[data-port]') || t.closest('[data-node-header]') || t.closest('[data-canvas-node-id]')) return
    const rc = canvasRef.current
    if (!rc) return
    const rect = rc.getBoundingClientRect()
    const v = viewportRef.current
    setQuickPicker({
      x: e.clientX, // 屏幕坐标，供 CatalogPanel 锚点定位（portal 渲染到 body）
      y: e.clientY,
      canvasX: snap((e.clientX - rect.left - v.x) / v.scale - NODE_WIDTH / 2, GRID_SIZE),
      canvasY: snap((e.clientY - rect.top - v.y) / v.scale - NODE_HEADER_HEIGHT / 2, GRID_SIZE),
    })
  }

  // 关闭就近选择面板：必须同时清掉拖线待连状态，否则之后任意方式建节点都会
  // 落在上次拖线松手的位置并莫名自动连线（pendingConnectRef 只在 createNode 消费时清）
  const closeQuickPicker = useCallback(() => {
    pendingConnectRef.current = null
    setQuickPicker(null)
  }, [])

  // 选中节点：在双击位置创建节点
  const quickPickNode = (node: NodeInfo) => {
    if (!quickPicker) return
    createNode(node.nodeType, quickPicker.canvasX, quickPicker.canvasY)
    closeQuickPicker()
  }

  // 点击空白处/按 Esc 关闭就近选择面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeQuickPicker() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeQuickPicker])

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await apiFetch<WorkflowItem[]>('/api/canvas-workflows')
      if (res.success && Array.isArray(res.data)) setWorkflows(res.data)
    } catch { /* */ }
  }, [])

  useEffect(() => {
    if (catalogMode !== 'workflows') return
    const timer = window.setTimeout(() => {
      void fetchWorkflows()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [catalogMode, fetchWorkflows])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchWorkflows(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchWorkflows])

  // 窄视口(手机/平板)默认收起节点库，避免占满屏幕把画布挤出视口（库已默认收起，此处保留兼容）
  useEffect(() => {
    if (window.innerWidth >= 992) return
    const timer = window.setTimeout(() => setCatalogPinned(false), 0)
    return () => window.clearTimeout(timer)
  }, [])

  // 画布临时保存：切到其他页面/刷新时把全部状态存 localStorage，回来时恢复。
  // 挂载时先恢复一次（无 pendingWorkflowImport/workflowId 抢占时），之后每次变化防抖写入。
  const CANVAS_DRAFT_KEY = 'canvas-draft-v1'
  const canvasHydratedRef = useRef(false)

  // 工具库：当前打开的工具面板（工作流快照 + 落点节点 ids）
  const [toolPanel, setToolPanel] = useState<{ tool: WorkflowTool; nodeIds: string[] } | null>(null)

  // 工具箱：线上已上架工具（官方优先），catalog「工具箱」里可直接导入画布调试
  const [remoteTools, setRemoteTools] = useState<Array<{ id: string; name: string; description: string | null; category: string | null; isOfficial: boolean }>>([])
  useEffect(() => {
    let alive = true
    void fetch('/api/tools?pageSize=50&sort=popular')
      .then((r) => r.json())
      .then((j) => {
        if (alive && j?.success && Array.isArray(j.data?.items)) setRemoteTools(j.data.items)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 导入线上工具的工作流快照到画布（调试/定制，改完可「存为工具」发布新版本）
  const importRemoteTool = useCallback((toolId: string, name: string) => {
    void (async () => {
      try {
        const res = await fetch(`/api/tools/${toolId}`)
        const j = await res.json()
        if (!j?.success || !j.data?.workflow?.nodes?.length) {
          message.error('工具快照加载失败')
          return
        }
        const wf = j.data.workflow as { nodes: CanvasNode[]; connections: Connection[] }
        commitHistoryRef.current()
        await animateLoadNodes(wf.nodes as CanvasNode[], (wf.connections ?? []) as Connection[])
        setRemixToolId(toolId)
        setWorkflowName(name || j.data.name || '')
        setCatalogPinned(false)
        setCatalogHover(false)
        message.success(`已导入工具「${j.data.name}」，可调整参数后「存为工具」发布新版本`)
      } catch {
        message.error('工具导入失败')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 提示词库（catalog「提示词库」）：公开提示词两类展示（创作型瀑布流 / 功能型模板卡）
  const [promptLibItems, setPromptLibItems] = useState<Array<{ id: string; title: string; content: string; category: string; kind: string; coverUrl: string | null; useCount: number }>>([])
  const [promptLibLoading, setPromptLibLoading] = useState(false)
  const promptLibLoadedRef = useRef(false)
  const loadPromptLib = useCallback(() => {
    if (promptLibLoadedRef.current) return
    promptLibLoadedRef.current = true
    setPromptLibLoading(true)
    void fetch('/api/prompts?scope=public&pageSize=60')
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && Array.isArray(j.data?.items)) setPromptLibItems(j.data.items)
      })
      .catch(() => {})
      .finally(() => setPromptLibLoading(false))
  }, [])
  useEffect(() => {
    if (catalogMode === 'presets' && catalogOpen) loadPromptLib()
  }, [catalogMode, catalogOpen, loadPromptLib])

  // 打开一个工具：导入其工作流快照到画布，并弹出配套工具面板
  const openTool = (tool: WorkflowTool) => {
    commitHistoryRef.current()
    const nodes = tool.nodes || []
    const rc = canvasRef.current?.getBoundingClientRect()
    const v = viewportRef.current
    const cx = rc ? (rc.width / 2 - v.x) / v.scale : 100
    const cy = rc ? (rc.height / 2 - v.y) / v.scale : 100
    const ids: string[] = []
    const newNodes: CanvasNode[] = nodes.map((nd, i) => {
      const info = nodeInfoMap.get(nd.type)
      const id = generateId('node')
      ids.push(id)
      const node: CanvasNode = {
        id, type: nd.type, label: nd.label || info?.label || nd.type, category: info?.category || 'data',
        x: snap(cx + (i - (nodes.length - 1) / 2) * 240, GRID_SIZE), y: snap(cy, GRID_SIZE),
        inputs: {}, outputs: {},
      }
      if (info) Object.entries(info.inputs).forEach(([k, p]) => { if ((p as { defaultValue?: unknown }).defaultValue !== undefined) node.inputs[k] = (p as { defaultValue?: unknown }).defaultValue })
      if (nd.inputs) node.inputs = { ...node.inputs, ...nd.inputs }
      if (nd.systemPrompt && nd.type === 'llm-chat') node.inputs.systemPrompt = nd.systemPrompt
      return node
    })
    setCanvasNodes((prev) => [...prev, ...newNodes])
    const conns = (tool.connections || []).map((c) => ({
      id: generateId('conn'), sourceNodeId: ids[c.source], sourcePort: c.sourcePort, targetNodeId: ids[c.target], targetPort: c.targetPort,
    }))
    if (conns.length) setConnections((prev) => [...prev, ...conns])
    setToolPanel({ tool, nodeIds: ids })
    if (ids.length) selectNode(ids[0])
    setCatalogPinned(false)
    setCatalogHover(false)
  }

  // 工具面板「一键运行」：先把绑定值写回对应节点，再驱动整条工作流
  const toolRun = (bindings: { nodeId: string; port: string; value: unknown }[]) => {
    if (!bindings.length) return
    setCanvasNodes((prev) =>
      prev.map((n) => {
        const hits = bindings.filter((b) => b.nodeId === n.id)
        if (!hits.length) return n
        const inputs = { ...n.inputs }
        for (const b of hits) inputs[b.port] = b.value
        return { ...n, inputs }
      })
    )
    // 等 setCanvasNodes 渲染后（canvasNodesRef 同步）再跑，确保输入已写回
    setTimeout(() => runWorkflow(), 0)
  }
  useEffect(() => {
    // 延后一帧：从 localStorage 恢复草稿（避免 effect 同步体内 setState 级联渲染）
    const timer = window.setTimeout(() => {
      try {
        const pending = readLocalText('pendingWorkflowImport')
        const wfId = new URLSearchParams(window.location.search).get('workflowId')
        if (pending || wfId) { canvasHydratedRef.current = true; return } // 外部导入优先，跳过草稿恢复
        const saved = readLocalText(CANVAS_DRAFT_KEY)
        if (saved) {
          const d = JSON.parse(saved)
          if (Array.isArray(d.nodes) && d.nodes.length > 0) {
            setCanvasNodes(d.nodes)
            setConnections(Array.isArray(d.connections) ? d.connections : [])
            if (d.viewport && typeof d.viewport.x === 'number') setViewport(d.viewport)
            if (typeof d.workflowName === 'string') setWorkflowName(d.workflowName)
            if (Array.isArray(d.executionLogs)) setExecutionLogs(d.executionLogs)
            message.info('已恢复上次画布')
          }
        }
      } catch { /* 草稿损坏则忽略 */ }
      canvasHydratedRef.current = true
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!canvasHydratedRef.current) return
    const t = setTimeout(() => {
      try {
        writeLocalJson(CANVAS_DRAFT_KEY, {
          nodes: canvasNodes,
          connections,
          viewport,
          workflowName,
          executionLogs,
          savedAt: Date.now(),
        })
      } catch { /* 超配额(大图)则静默放弃本轮写入 */ }
    }, 800)
    return () => clearTimeout(t)
  }, [canvasNodes, connections, viewport, workflowName, executionLogs])

  // 读取待导入的官方工作流（从管理面板演示跳转过来）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const pending = readLocalText('pendingWorkflowImport')
        if (pending) {
          const wf = JSON.parse(pending)
          if (wf && wf.nodes) {
            setCanvasNodes(wf.nodes as CanvasNode[])
            setConnections(wf.connections as Connection[])
            setWorkflowName(wf.name || '')
            message.success(`已导入工作流: ${wf.name || ''}`)
          }
          removeLocalKey('pendingWorkflowImport')
        }
      } catch {
        removeLocalKey('pendingWorkflowImport')
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // B9: 从 Agent projectHandoff 跳转 ?workflowId= 自动加载画布
  useEffect(() => {
    // 延后一帧：处理 URL 参数（?workflowId= / ?mode= / ?prompt=）
    const timer = window.setTimeout(() => {
      try {
        const params = new URLSearchParams(window.location.search)
        const wfId = params.get('workflowId')
        if (wfId) {
          fetch(`/api/canvas-workflows/${wfId}`)
            .then((res) => res.json())
            .then((data) => {
              if (data.success && data.data) {
                setWorkflowName(data.data.name || '未命名画布')
                setCanvasNodes((data.data.nodes || []) as CanvasNode[])
                setConnections((data.data.connections || []) as Connection[])
                message.success(`已打开 Agent 生成的画布: ${data.data.name || ''}`)
              } else {
                message.error(data.message || '画布加载失败')
              }
            })
            .catch(() => message.error('画布加载失败'))
          // 清理 URL，避免刷新重复加载
          window.history.replaceState({}, '', window.location.pathname)
        }

        // 首页「动手创作 / 直接使用」进入：?mode= 决定左侧面板默认模式；?prompt= 预填 Copilot
        const mode = params.get('mode')
        if (mode === 'use') setCatalogMode('workflows')
        else if (mode === 'draw') setCatalogMode('nodes')
        const promptText = params.get('prompt')
        if (promptText) {
          setCopilotExternalPrompt(promptText)
          // 首页胶囊动画进入（copilotAutoRun=1）：Copilot 打开后自动开始执行
          if (params.get('copilotAutoRun')) setCopilotAutoRun(true)
        }
      } catch { /* ignore */ }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // B9: 等 nodeInfoMap 就绪后画布正常渲染（独立渲染副作用已在上方）
  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0) return
    const rect = canvasRef.current.getBoundingClientRect()
    setViewport({ x: rect.width / 2 - NODE_WIDTH / 2, y: rect.height / 2 - 200, scale: 1 })
  }, [nodes.length])

  // ------------------------------------------------------------------
  // Coordinate transforms
  // ------------------------------------------------------------------

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - viewport.x) / viewport.scale,
        y: (screenY - viewport.y) / viewport.scale,
      }
    },
    [viewport]
  )

  const canvasToScreen = useCallback(
    (canvasX: number, canvasY: number) => {
      return {
        x: canvasX * viewport.scale + viewport.x,
        y: canvasY * viewport.scale + viewport.y,
      }
    },
    [viewport]
  )

  // ------------------------------------------------------------------
  // Drag / Drop from catalog
  // ------------------------------------------------------------------

  const handleCatalogDragStart = (e: React.DragEvent, node: NodeInfo) => {
    e.dataTransfer.setData('application/json', JSON.stringify(node))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)

    // 1. 支持外部文件（图片/音频）直接拖入画布释放生成节点（对齐 ComfyArt 核心体验）
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && canvasRef.current) {
      const files = Array.from(e.dataTransfer.files)
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      const audioFiles = files.filter((f) => f.type.startsWith('audio/'))
      const rect = canvasRef.current.getBoundingClientRect()
      const pos = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)

      if (imageFiles.length > 0) {
        commitHistory()
        if (imageFiles.length === 1) {
          const f = imageFiles[0]
          const reader = new FileReader()
          reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string
            if (!dataUrl) return
            const id = generateId('node')
            const newNode: CanvasNode = {
              id,
              type: 'image-upload',
              label: '图片上传',
              category: 'image',
              x: snap(pos.x - NODE_WIDTH / 2, GRID_SIZE),
              y: snap(pos.y - NODE_HEADER_HEIGHT / 2, GRID_SIZE),
              inputs: { image: dataUrl, imageUrl: dataUrl },
              outputs: { image: dataUrl, imageUrl: dataUrl },
            }
            setCanvasNodes((prev) => [...prev, newNode])
            selectNode(id)
            message.success('已拖入图片并创建节点')
          }
          reader.readAsDataURL(f)
        } else {
          // 多张图片直接生成批量图片节点
          const readers = imageFiles.map((f) => {
            return new Promise<string>((resolve) => {
              const r = new FileReader()
              r.onload = (ev) => resolve((ev.target?.result as string) || '')
              r.readAsDataURL(f)
            })
          })
          Promise.all(readers).then((urls) => {
            const valid = urls.filter(Boolean)
            if (!valid.length) return
            const id = generateId('node')
            const newNode: CanvasNode = {
              id,
              type: 'image-upload-batch',
              label: '批量图片上传',
              category: 'image',
              x: snap(pos.x - NODE_WIDTH / 2, GRID_SIZE),
              y: snap(pos.y - NODE_HEADER_HEIGHT / 2, GRID_SIZE),
              inputs: { images: valid },
              outputs: { images: valid },
            }
            setCanvasNodes((prev) => [...prev, newNode])
            selectNode(id)
            message.success(`已拖入 ${valid.length} 张图片并生成批量节点`)
          })
        }
        return
      }

      if (audioFiles.length > 0) {
        commitHistory()
        const f = audioFiles[0]
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          if (!dataUrl) return
          const id = generateId('node')
          const newNode: CanvasNode = {
            id,
            type: 'audio-upload',
            label: '音频上传',
            category: 'audio',
            x: snap(pos.x - NODE_WIDTH / 2, GRID_SIZE),
            y: snap(pos.y - NODE_HEADER_HEIGHT / 2, GRID_SIZE),
            inputs: { audioUrl: dataUrl },
            outputs: { audioUrl: dataUrl },
          }
          setCanvasNodes((prev) => [...prev, newNode])
          selectNode(id)
          message.success('已拖入音频并创建节点')
        }
        reader.readAsDataURL(f)
        return
      }
    }

    // 2. 节点库拖入
    const raw = e.dataTransfer.getData('application/json')
    if (!raw || !canvasRef.current) return

    try {
      const info: NodeInfo = JSON.parse(raw)
      const rect = canvasRef.current.getBoundingClientRect()
      const pos = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)

      const newNode: CanvasNode = {
        id: generateId('node'),
        type: info.nodeType,
        label: info.label,
        category: info.category,
        x: snap(pos.x - NODE_WIDTH / 2, GRID_SIZE),
        y: snap(pos.y - NODE_HEADER_HEIGHT / 2, GRID_SIZE),
        inputs: {},
        outputs: {},
      }

      // Seed default input values
      Object.entries(info.inputs).forEach(([key, port]) => {
        if (port.defaultValue !== undefined) {
          newNode.inputs[key] = port.defaultValue
        }
      })

      setCanvasNodes((prev) => [...prev, newNode])
      selectNode(newNode.id)
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Mouse interactions
  // ------------------------------------------------------------------

  // ---------------------------------------------------------------

  // 一键导入预设到画布（单节点/工作流批量落点；提示词集仅展示不落点）
  const importPreset = (tpl: PresetTemplate) => {
    if (tpl.category === 'prompt') return
    commitHistoryRef.current()
    const nodes = tpl.nodes || []
    const rc = canvasRef.current?.getBoundingClientRect()
    const v = viewportRef.current
    const cx = rc ? (rc.width / 2 - v.x) / v.scale : 100
    const cy = rc ? (rc.height / 2 - v.y) / v.scale : 100
    const ids: string[] = []
    const newNodes: CanvasNode[] = nodes.map((nd, i) => {
      const info = nodeInfoMap.get(nd.type)
      const id = generateId('node')
      ids.push(id)
      const node: CanvasNode = {
        id, type: nd.type, label: nd.label || info?.label || nd.type, category: info?.category || 'data',
        x: snap(cx + (i - (nodes.length - 1) / 2) * 240, GRID_SIZE), y: snap(cy, GRID_SIZE),
        inputs: {},
        outputs: {},
      }
      if (info) Object.entries(info.inputs).forEach(([k, p]) => { if ((p as { defaultValue?: unknown }).defaultValue !== undefined) node.inputs[k] = (p as { defaultValue?: unknown }).defaultValue })
      if (nd.inputs) node.inputs = { ...node.inputs, ...nd.inputs }
      if (nd.systemPrompt && nd.type === 'llm-chat') node.inputs.systemPrompt = nd.systemPrompt
      return node
    })
    setCanvasNodes((prev) => [...prev, ...newNodes])
    const conns = (tpl.connections || []).map((c) => ({
      id: generateId('conn'), sourceNodeId: ids[c.source], sourcePort: c.sourcePort, targetNodeId: ids[c.target], targetPort: c.targetPort,
    }))
    if (conns.length) setConnections((prev) => [...prev, ...conns])
    if (ids.length) selectNode(ids[0])
    setCatalogPinned(false)
    setCatalogHover(false)
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-port]') || target.closest('[data-node-header]')) return

    const isTouch = e.pointerType !== 'mouse'
    // 触控多点追踪
    if (isTouch) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      // 已在拖拽/连线中:仅从"平移"状态叠加第二指进入捏合;节点/连线拖拽不叠加
      if (drag.type !== 'idle') {
        if (drag.type === 'pan' && activePointersRef.current.size >= 2) {
          e.preventDefault()
          const [a, b] = [...activePointersRef.current.values()]
          pinchRef.current = {
            startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            startScale: viewport.scale,
            midX: (a.x + b.x) / 2,
            midY: (a.y + b.y) / 2,
          }
          dragPointerIdRef.current = null
          setDrag({ type: 'idle' })
        }
        return
      }
      // 首指:记录发起指针;单指在空白处拖动 → 平移画布(对应鼠标的 Ctrl/中键平移)
      // 双击空白 → 放大(绕该点,锚点公式与 wheel 一致)
      const now = Date.now()
      const lastTap = lastTapRef.current
      if (lastTap && now - lastTap.time < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTapRef.current = null
        e.preventDefault()
        const rect = canvasRef.current!.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const newScale = clamp(viewport.scale * 1.4, MIN_SCALE, MAX_SCALE)
        const ratio = newScale / viewport.scale
        setViewport({ x: px - (px - viewport.x) * ratio, y: py - (py - viewport.y) * ratio, scale: newScale })
        return
      }
      lastTapRef.current = { x: e.clientX, y: e.clientY, time: now }
      dragPointerIdRef.current = e.pointerId
      e.preventDefault()
      setDrag({ type: 'pan', startX: e.clientX, startY: e.clientY, startViewport: { ...viewport } })
      return
    }

    dragPointerIdRef.current = e.pointerId

    // Middle mouse or Ctrl+Left pans the canvas
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
      e.preventDefault()
      setDrag({
        type: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        startViewport: { ...viewport },
      })
      return
    }

    // 空白处左键按下 → 框选（选择多个节点）；仅点击无位移 → 取消选中。平移画布改由中键 / Ctrl+左键 承担
    if (e.button === 0 && (target === canvasRef.current || target.closest('[data-canvas-background]'))) {
      setDrag({ type: 'select', startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
    }
  }

  const handleNodeHeaderPointerDown = (e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation()
    if (e.button !== 0) return
    // 记录发起拖拽的指针（鼠标/触控都要），window pointermove 据此只跟随该指针
    dragPointerIdRef.current = e.pointerId
    if (e.pointerType !== 'mouse') {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      e.preventDefault()
    }

    const node = canvasNodes.find((n) => n.id === nodeId)
    if (!node) return

    // Shift 多选切换；普通点击单选（面板延迟到 pointerup 无位移时展开，拖拽不触发）
    if (e.shiftKey) {
      pendingPanelRef.current = null
      setSelectedNodeIds((prev) => {
        const has = prev.includes(nodeId)
        const next = has ? prev.filter((x) => x !== nodeId) : [...prev, nodeId]
        setSelectedNodeId(next.length === 1 ? next[0] : null)
        setPanelOpenNodeId(next.length === 1 && !hasInlineBody(node.type) ? next[0] : null)
        return next
      })
    } else {
      // 点击选中：结果卡身类型弹出浮动参数层（上参数条+下填写面板），表单类型弹旧面板
      pendingPanelRef.current = nodeId
      selectNode(nodeId)
    }

    setDrag({
      type: 'node',
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      startNodeX: node.x,
      startNodeY: node.y,
    })
  }

  // 节点右键/长按菜单:选中该节点并弹出复制/删除
  const openNodeMenu = (point: { clientX: number; clientY: number }, nodeId: string, fromTouch = false) => {
    selectNode(nodeId)
    setDrag({ type: 'idle' })
    dragPointerIdRef.current = null
    if (fromTouch) nodeMenuSuppressCloseRef.current = Date.now()
    // 菜单在长按/右键点弹出；触屏边缘处钳制到视口内，避免溢出点不到
    const menuW = 120, menuH = 96
    const x = Math.max(4, Math.min(point.clientX, window.innerWidth - menuW - 4))
    const y = Math.max(4, Math.min(point.clientY, window.innerHeight - menuH - 4))
    setNodeMenu({ x, y, nodeId })
  }

  // ---- 连线创建唯一入口：统一校验 + 目标输入口校正 + 记录撤销历史 + 批量展开侦测 ----
  // 所有画布拖线连法（端口到端口 / 输出落到目标节点）都汇聚到此，保证连法一致、可撤销。
  const tryConnect = (sourceNodeId: string, sourcePort: string, targetNodeId: string, portKey: string, tgtNodeOverride?: CanvasNode): boolean => {
    if (sourceNodeId === targetNodeId) return false
    // 用 canvasStateRef.current 而非闭包里的 canvasNodes/connections：createNode 是 useCallback 强化，可能捕获旧闭包；
    // 且拖线悬空自动连线时新节点刚用 setCanvasNodes 加入、尚未触发重渲染，故用 ref 拿最新（tgtNodeOverride 注入新的目标节点）
    const cur = canvasStateRef.current
    const srcNode = cur.nodes.find((n) => n.id === sourceNodeId)
    const tgtNode = tgtNodeOverride ?? cur.nodes.find((n) => n.id === targetNodeId)
    if (!srcNode || !tgtNode) return false
    const srcInfo = nodeInfoMap.get(srcNode.type)
    const srcOutputType = srcInfo?.outputs?.[sourcePort]?.type
    // 用 getEffectiveNodeInfo 查目标端口类型，确保拿到动态端口(如视觉 LLM 的 image 输入)
    const tgtInfo = getEffectiveNodeInfo(tgtNode, nodeInfoMap.get(tgtNode.type), modelOptions)
    // 端口悬浮化：UI 只有一颗输入球（key=第一个可见输入），按源端口类型校正到真正兼容的输入 key
    // （image 源→referenceImage/image，string 源→prompt），保证「图片走参考图口、文本走提示词口」
    const resolvedKey = tgtInfo ? (resolveTargetInputKey(srcOutputType || 'string', tgtInfo, tgtNode.type) || portKey) : portKey
    const tgtPortType = tgtInfo?.inputs?.[resolvedKey]?.type
    // 类型校验：不兼容直接拒绝，避免运行期才炸
    if (!canConnect(srcOutputType, tgtPortType)) {
      message.error(`无法连接：${srcInfo?.outputs?.[sourcePort]?.label || sourcePort} 不能连到 ${tgtInfo?.inputs?.[resolvedKey]?.label || resolvedKey}`)
      return false
    }
    // 只有目标端口是标量数据(string/number/boolean/object)时才按序取数组元素;
    // 数组连到 image/array/未知(动态)端口时整传,让视觉模型一次收全部图
    const shouldIndex = srcOutputType === 'array' && ['string', 'number', 'boolean', 'object'].includes(tgtPortType ?? '')
    const autoIndex = shouldIndex
      ? cur.connections.filter((c) => c.sourceNodeId === sourceNodeId && c.sourcePort === sourcePort).length
      : undefined
    // 去重（按校正后的 key 判重）
    const dupExists = cur.connections.some(
      (c) => c.sourceNodeId === sourceNodeId && c.sourcePort === sourcePort && c.targetNodeId === targetNodeId && c.targetPort === resolvedKey
    )
    if (dupExists) return true
    commitHistoryRef.current()
    setConnections((prev) => [
      ...prev,
      {
        id: generateId('conn'),
        sourceNodeId,
        sourcePort,
        targetNodeId,
        targetPort: resolvedKey,
        index: autoIndex,
      },
    ])
    // 批量节点：连上「提示词数组」输出时，若节点内 JSON 字面量可解析出 N>=2，自动展开
    // 但 outputMode === 'index' 时下游是作者静态排布的（每份自己带 index），
    // 这里不能展开，否则会多克隆节点、多跑多扣费。
    if (
      srcNode.type === 'json-prompt-batch' &&
      sourcePort === 'prompts' &&
      String(srcNode.inputs?.outputMode ?? 'expand') !== 'index'
    ) {
      const { blocks } = parsePromptBlocks(srcNode.inputs.json, String(srcNode.inputs.field ?? 'prompt'))
      if (blocks.length >= 2) {
        expandBatchNodeRef.current(srcNode.id, { targetNodeId, targetPort: resolvedKey })
      }
    }
    return true
  }

  const handlePortPointerDown = (e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => {
    e.stopPropagation()
    e.preventDefault()
    if (side !== 'output') return

    const node = canvasNodes.find((n) => n.id === nodeId)
    if (!node) return

    const sourceNodeId = nodeId
    const sourcePort = portKey

    if (!canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()

    // 自包含连线：按下 output 端口时直接注册一次性 window 监听，不依赖 useEffect 的 drag 状态
    setDrag({
      type: 'connection',
      sourceNodeId,
      sourcePort,
      endX: e.clientX,
      endY: e.clientY,
    })
    dragPointerIdRef.current = e.pointerId
    if (e.pointerType !== 'mouse') activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    const pid = e.pointerId
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      // 存储屏幕坐标即可，渲染时统一转换
      setDrag((d) => (d.type === 'connection' ? { ...d, endX: ev.clientX, endY: ev.clientY } : d))
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      activePointersRef.current.delete(pid)
      dragPointerIdRef.current = null
      // 命中检测：找指针下的 input 端口
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const portEl = el?.closest('[data-port][data-side="input"]') as HTMLElement | null
      if (portEl) {
        const targetNodeId = portEl.getAttribute('data-node-id')
        const targetPort = portEl.getAttribute('data-port-key')
        // 统一走 tryConnect：校验类型/自我连接/去重，并记录撤销历史
        if (targetNodeId && targetPort && targetNodeId !== sourceNodeId) {
          tryConnect(sourceNodeId, sourcePort, targetNodeId, targetPort)
        }
      } else {
        // 松手落在节点卡身（非端口球）→ 按语义直接连到该节点（找类型兼容口），不算落空白
        const nodeEl = el?.closest('[data-canvas-node-id]') as HTMLElement | null
        const dropNodeId = nodeEl?.getAttribute('data-canvas-node-id')
        if (dropNodeId && dropNodeId !== sourceNodeId) {
          const tgtNode = canvasStateRef.current.nodes.find((n) => n.id === dropNodeId)
          const tgtInfo = tgtNode ? nodeInfoMap.get(tgtNode.type) : undefined
          const srcInfo = canvasStateRef.current.nodes.find((n) => n.id === sourceNodeId)
          const srcType = srcInfo ? nodeInfoMap.get(srcInfo.type)?.outputs?.[sourcePort]?.type : undefined
          if (tgtInfo && srcType) {
            const inKey = resolveTargetInputKey(srcType, tgtInfo, tgtNode!.type)
            if (inKey) {
              try { tryConnect(sourceNodeId, sourcePort, dropNodeId, inKey) } catch { /* ignore */ }
            }
          }
        } else if (canvasRef.current) {
          // 松手在空白处未连上 → 记录待连线源与该位置，就近弹出节点选择面板（quickPicker），选中节点后自动连线
          const rc = canvasRef.current.getBoundingClientRect()
          const v = viewportRef.current
          const cx = snap((ev.clientX - rc.left - v.x) / v.scale - NODE_WIDTH / 2, GRID_SIZE)
          const cy = snap((ev.clientY - rc.top - v.y) / v.scale - NODE_HEADER_HEIGHT / 2, GRID_SIZE)
          pendingConnectRef.current = { sourceNodeId, sourcePort, x: cx, y: cy }
          // 用松手点的屏幕坐标定位 quickPicker（portal 渲染到 body），选中节点后 createNode 会读取 pendingConnectRef 自动连线
          setQuickPicker({ x: ev.clientX, y: ev.clientY, canvasX: cx, canvasY: cy })
        }
      }
      setDrag({ type: 'idle' })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp, { once: true })
  }

  const handlePortPointerUp = (e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => {
    e.stopPropagation()

    if (drag.type !== 'connection') return
    if (side === 'output') return

    // 统一走 tryConnect：校验类型/自我连接/去重，并把目标输入口校正 + 撤销历史一并处理
    tryConnect(drag.sourceNodeId, drag.sourcePort, nodeId, portKey)
    setDrag({ type: 'idle' })
  }

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const d = dragRef.current
      const vp = viewportRef.current
      // 更新活动指针位置(捏合追踪)
      if (activePointersRef.current.has(e.pointerId)) {
        activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }

      // 双指捏合缩放:绕两指中点,锚点公式与 wheel 缩放一致
      if (pinchRef.current && activePointersRef.current.size >= 2) {
        const [a, b] = [...activePointersRef.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const { startDist, startScale, midX, midY } = pinchRef.current
        const newScale = clamp(startScale * (dist / startDist), MIN_SCALE, MAX_SCALE)
        const rect = canvasRef.current!.getBoundingClientRect()
        const midXc = midX - rect.left
        const midYc = midY - rect.top
        const scaleRatio = newScale / vp.scale
        setViewport({ x: midXc - (midXc - vp.x) * scaleRatio, y: midYc - (midYc - vp.y) * scaleRatio, scale: newScale })
        return
      }

      // 非拖拽发起指针的移动忽略(防多点串扰)
      if (e.pointerId !== dragPointerIdRef.current) return

      if (d.type === 'pan') {
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        setViewport({ ...d.startViewport, x: d.startViewport.x + dx, y: d.startViewport.y + dy })
        return
      }

      if (d.type === 'node') {
        // 屏幕坐标差除以缩放系数得到画布坐标差；拖动中不做网格吸附(保证跟手)，松手时再吸附
        const dx = (e.clientX - d.startX) / vp.scale
        const dy = (e.clientY - d.startY) / vp.scale
        setCanvasNodes((prev) =>
          prev.map((n) =>
            n.id === d.nodeId ? { ...n, x: d.startNodeX + dx, y: d.startNodeY + dy } : n
          )
        )
        return
      }

      if (d.type === 'select') {
        const rect = canvasRef.current!.getBoundingClientRect()
        const sx = (d.startX - rect.left - vp.x) / vp.scale
        const sy = (d.startY - rect.top - vp.y) / vp.scale
        const cx = (e.clientX - rect.left - vp.x) / vp.scale
        const cy = (e.clientY - rect.top - vp.y) / vp.scale
        setSelectRect({
          x: Math.min(sx, cx),
          y: Math.min(sy, cy),
          w: Math.abs(cx - sx),
          h: Math.abs(cy - sy),
        })
        return
      }
      // connection 模式由 handlePortPointerDown 内的自包含 listener 处理，不在此处干预
    }

    const handlePointerUp = (e: PointerEvent) => {
      const d = dragRef.current
      const vp = viewportRef.current
      activePointersRef.current.delete(e.pointerId)
      // 捏合:任一指抬起即结束,保留当前缩放
      if (pinchRef.current) {
        pinchRef.current = null
        dragPointerIdRef.current = null
        setDrag({ type: 'idle' })
        return
      }
      // 非发起拖拽的指针抬起,忽略
      if (e.pointerId !== dragPointerIdRef.current) return
      dragPointerIdRef.current = null

      // connection 模式由 handlePortPointerDown 的自包含 listener 处理，此处不干预
      if (d.type === 'connection') return

      // 空白处按下(pan)结束：无位移的「点击」→ 取消选中并收起参数面板
      if (d.type === 'pan' && d.startViewport) {
        const moved = Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3
        if (!moved) {
          clearSelection()
          setPanelOpenNodeId(null)
        }
        setDrag({ type: 'idle' })
        return
      }

      // 框选结束：无位移→取消选中；有位移→按矩形命中节点多选（坐标换算同 select 分支）
      if (d.type === 'select') {
        const moved = Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4
        if (!moved) {
          clearSelection()
          setPanelOpenNodeId(null)
        } else {
          const rect = canvasRef.current!.getBoundingClientRect()
          const v = viewportRef.current
          const x1 = (d.startX - rect.left - v.x) / v.scale
          const y1 = (d.startY - rect.top - v.y) / v.scale
          const x2 = (e.clientX - rect.left - v.x) / v.scale
          const y2 = (e.clientY - rect.top - v.y) / v.scale
          const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
          const hit = canvasStateRef.current.nodes
            .filter((n) => {
              const nw = 260
              const nh = 110
              return n.x < box.x + box.w && n.x + nw > box.x && n.y < box.y + box.h && n.y + nh > box.y
            })
            .map((n) => n.id)
          if (hit.length > 0) setSelectedNodeIds(hit)
          else clearSelection()
        }
        setSelectRect(null)
        setDrag({ type: 'idle' })
        return
      }

      // 节点拖拽结束 → 吸附网格并记录撤销历史；无位移的「点击」才展开参数面板
      if (d.type === 'node') {
        const moved = Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4
        if (moved) {
          setPanelOpenNodeId(null)
          setCanvasNodes((prev) =>
            prev.map((n) => (n.id === d.nodeId ? { ...n, x: snap(n.x, GRID_SIZE), y: snap(n.y, GRID_SIZE) } : n))
          )
        } else if (pendingPanelRef.current) {
          setPanelOpenNodeId(pendingPanelRef.current)
        }
        pendingPanelRef.current = null
        commitHistoryRef.current()
      }

      setDrag({ type: 'idle' })
    }

    const handlePointerCancel = (e: PointerEvent) => {
      activePointersRef.current.delete(e.pointerId)
      if (e.pointerId === dragPointerIdRef.current) dragPointerIdRef.current = null
      pinchRef.current = null
      setSelectRect(null)
      setDrag({ type: 'idle' })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [])

  // 使用原生 wheel 事件（passive: false）以支持 preventDefault
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      // 滚轮若发生在可滚动区域(如 Copilot 聊天/日志面板/文本框)内,交还原生滚动,不缩放画布
      let el = e.target as HTMLElement | null
      while (el && el !== canvas) {
        const style = getComputedStyle(el)
        const scrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
          el.scrollHeight > el.clientHeight && e.deltaY !== 0
        const scrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay') &&
          el.scrollWidth > el.clientWidth && e.deltaX !== 0
        if (scrollY || scrollX) return // 交给原生滚动
        el = el.parentElement
      }
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const zoomIntensity = 0.001
      const delta = -e.deltaY * zoomIntensity
      const newScale = clamp(viewport.scale * (1 + delta), MIN_SCALE, MAX_SCALE)

      const scaleRatio = newScale / viewport.scale
      const newX = mouseX - (mouseX - viewport.x) * scaleRatio
      const newY = mouseY - (mouseY - viewport.y) * scaleRatio

      setViewport({ x: newX, y: newY, scale: newScale })
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [viewport.scale, viewport.x, viewport.y])

  // ------------------------------------------------------------------
  // Toolbar actions
  // ------------------------------------------------------------------

  const zoomIn = () => {
    setViewport((v) => {
      const newScale = clamp(v.scale * 1.2, MIN_SCALE, MAX_SCALE)
      const cx = (canvasRef.current?.clientWidth || 0) / 2
      const cy = (canvasRef.current?.clientHeight || 0) / 2
      return {
        x: cx - (cx - v.x) * (newScale / v.scale),
        y: cy - (cy - v.y) * (newScale / v.scale),
        scale: newScale,
      }
    })
  }

  const zoomOut = () => {
    setViewport((v) => {
      const newScale = clamp(v.scale / 1.2, MIN_SCALE, MAX_SCALE)
      const cx = (canvasRef.current?.clientWidth || 0) / 2
      const cy = (canvasRef.current?.clientHeight || 0) / 2
      return {
        x: cx - (cx - v.x) * (newScale / v.scale),
        y: cy - (cy - v.y) * (newScale / v.scale),
        scale: newScale,
      }
    })
  }

  const fitView = () => {
    if (canvasNodes.length === 0 || !canvasRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect()
      setViewport({ x: (rect?.width || 0) / 2, y: (rect?.height || 0) / 2, scale: 1 })
      return
    }

    const rect = canvasRef.current.getBoundingClientRect()
    const xs = canvasNodes.map((n) => n.x)
    const ys = canvasNodes.map((n) => n.y)
    const minX = Math.min(...xs) - 100
    const maxX = Math.max(...xs) + NODE_WIDTH + 100
    const minY = Math.min(...ys) - 100
    const maxY = Math.max(...ys) + 400

    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const scaleX = rect.width / contentWidth
    const scaleY = rect.height / contentHeight
    const scale = clamp(Math.min(scaleX, scaleY) * 0.9, MIN_SCALE, MAX_SCALE)

    setViewport({
      x: rect.width / 2 - (minX + contentWidth / 2) * scale,
      y: rect.height / 2 - (minY + contentHeight / 2) * scale,
      scale,
    })
  }
  // 回填 ref（在 effect 中写，避免渲染期访问 ref）：animateLoadNodes 声明更早，通过 ref 调用绕开 TDZ
  useEffect(() => {
    fitViewRef.current = fitView
  })

  // ---- 撤销 / 复制粘贴 ----
  // 深拷贝快照(节点 inputs 可能嵌套)
  const { undoStack, redoStack, commitHistory, undo, redo } = useCanvasHistory({
    getSnapshot: useCallback(() => ({ nodes: canvasNodes, connections, stickyNotes: stickyNotesRef.current as unknown as HistorySnapshot['stickyNotes'] }), [canvasNodes, connections]),
    restore: useCallback((snap) => {
      setCanvasNodes(snap.nodes)
      setConnections(snap.connections)
      if (snap.stickyNotes) {
        setStickyNotes(snap.stickyNotes as StickyNote[])
      }
      clearSelection()
    }, [clearSelection]),
  })
  // 回填 ref：上方 importRemoteTool 等早声明回调通过 ref 调用，绕开「变量在声明前被访问」
  useEffect(() => {
    commitHistoryRef.current = commitHistory
  })

  // 复制选中节点 + 相关连线
  const { clipboard, copySelected, pasteClipboard } = useClipboard({
    getSelectedNodeIds: useCallback(() => selectedNodeIds, [selectedNodeIds]),
    getGraph: useCallback(() => ({ nodes: canvasNodes, connections }), [canvasNodes, connections]),
    commitHistory,
    paste: useCallback((nodes, conns, newIds) => {
      setCanvasNodes((prev) => [...prev, ...nodes])
      setConnections((prev) => [...prev, ...conns])
      setSelectedNodeIds(newIds)
      setSelectedNodeId(newIds[0] ?? null)
      const first = nodes[0]
      setPanelOpenNodeId(first && hasInlineBody(first.type) ? null : newIds[0] ?? null)
    }, []),
  })

  // 删除选中节点(支持多选)，记录撤销历史
  const deleteSelected = useCallback(() => {
    const ids = selectedNodeIds.length > 0 ? selectedNodeIds : (selectedNodeId ? [selectedNodeId] : [])
    if (ids.length === 0) return
    commitHistory()
    const idSet = new Set(ids)
    setCanvasNodes((prev) => prev.filter((n) => !idSet.has(n.id)))
    setConnections((prev) => prev.filter((c) => !idSet.has(c.sourceNodeId) && !idSet.has(c.targetNodeId)))
    clearSelection()
  }, [selectedNodeIds, selectedNodeId, commitHistory])

  // ---- Copilot 可调用的画布操作 ----
  const createNode = useCallback((nodeType: string, x?: number, y?: number): string => {
    commitHistory()
    const info = nodeInfoMap.get(nodeType)
    const id = generateId('node')
    // 若正处于「拖线待连线」状态，节点落在松手位置；否则用传入坐标或随机位置
    const pend = pendingConnectRef.current
    const nx = pend ? pend.x : (x ?? 200 + Math.random() * 200)
    const ny = pend ? pend.y : (y ?? 100 + Math.random() * 200)
    const newNode: CanvasNode = {
      id,
      type: nodeType,
      label: info?.label || nodeType,
      category: info?.category || 'data',
      x: snap(nx, GRID_SIZE),
      y: snap(ny, GRID_SIZE),
      inputs: {},
      outputs: {},
    }
    // Seed 默认值
    if (info) {
      Object.entries(info.inputs).forEach(([key, port]) => {
        if (port.defaultValue !== undefined) newNode.inputs[key] = port.defaultValue
      })
    }
    setCanvasNodes((prev) => [...prev, newNode])
    selectNode(id)
    // 若拖线悬空等待选节点：自动与源端口连线（找类型兼容的输入口）
    if (pend) {
      pendingConnectRef.current = null
      const src = canvasStateRef.current.nodes.find((n) => n.id === pend.sourceNodeId)
      const srcInfo = src ? nodeInfoMap.get(src.type) : undefined
      const outType = (srcInfo && srcInfo.outputs && srcInfo.outputs[pend.sourcePort]?.type) as string | undefined
      if (outType && info) {
        // 与 tryConnect 落点校正同一套规则（visibleInputKeys + image→referenceImage、string→prompt），
        // 别用严格相等遍历全部 inputs——会漏掉 image→string 强转、命中 PANEL_ONLY 隐藏参数口
        const inKey = resolveTargetInputKey(outType, info, nodeType)
        if (inKey) {
          try { tryConnect(pend.sourceNodeId, pend.sourcePort, id, inKey, newNode) } catch { /* ignore */ }
        }
      }
    }
    return id
  }, [nodeInfoMap, commitHistory])

  // 触屏无法用 HTML5 drag 拖入节点：点按节点库条目 → 在画布中心(带级联偏移)创建
  const handleCatalogTap = (node: NodeInfo) => {
    if (!canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const sider = document.querySelector('.ant-layout-sider') as HTMLElement | null
    const siderW = sider?.offsetWidth ?? 220
    const narrow = window.innerWidth < 992
    // 节点落点用"添加后"的 catalog 宽度计算：窄屏添加后自动收起 catalog
    const catalogW = 0 // 库已改为浮层下拉，不占画布布局宽度
    const canvasW = Math.max(0, window.innerWidth - siderW - catalogW)
    const offset = canvasNodes.length * 24
    const worldX = (canvasW / 2 - viewport.x) / viewport.scale + offset
    const worldY = (rect.height / 2 - viewport.y) / viewport.scale + offset
    createNode(node.nodeType, snap(worldX - NODE_WIDTH / 2, GRID_SIZE), snap(worldY - NODE_HEADER_HEIGHT / 2, GRID_SIZE))
    if (narrow) {
      setCatalogPinned(false)
      setCatalogHover(false)
    }
  }

  const deleteNodeById = useCallback((id: string) => {
    commitHistory()
    const removed = new Set([id])
    // 级联删除：该节点是批量源时，一并删除其展开出的副本
    for (const n of canvasNodes) {
      if (n.batch?.sourceId === id) removed.add(n.id)
    }
    setCanvasNodes((prev) => prev.filter((n) => !removed.has(n.id)))
    setConnections((prev) => prev.filter((c) => !removed.has(c.sourceNodeId) && !removed.has(c.targetNodeId)))
    deselectNodeIfRemoved(removed)
  }, [commitHistory, canvasNodes])

  const connectNodesOp = useCallback((sourceId: string, sourcePort: string, targetId: string, targetPort: string): boolean => {
    const srcNode = canvasNodes.find((n) => n.id === sourceId)
    const tgtNode = canvasNodes.find((n) => n.id === targetId)
    const srcType = srcNode ? nodeInfoMap.get(srcNode.type)?.outputs?.[sourcePort]?.type : undefined
    const tgtType = tgtNode ? nodeInfoMap.get(tgtNode.type)?.inputs?.[targetPort]?.type : undefined
    if (!canConnect(srcType, tgtType)) return false
    setConnections((prev) => {
      const exists = prev.some((c) => c.sourceNodeId === sourceId && c.sourcePort === sourcePort && c.targetNodeId === targetId && c.targetPort === targetPort)
      if (exists) return prev
      return [...prev, { id: generateId('conn'), sourceNodeId: sourceId, sourcePort, targetNodeId: targetId, targetPort }]
    })
    return true
  }, [canvasNodes, nodeInfoMap])

  /**
   * 一键衍生创作流转（学习 ComfyArt 原子动作链路）
   * 用户在任何图片卡片上点击衍生创作（变体、涂鸦漫改、转视频、裁剪、视觉分析、超分）
   * 自动在右侧创建目标节点、自动建立端口连线、注入预设提示词与配置，并选中新节点
   */
  const handleDeriveNode = useCallback((
    sourceNodeId: string,
    actionType: 'remix' | 'face-doodle' | 'animate' | 'crop' | 'vision' | 'upscale',
    imageUrl: string
  ) => {
    commitHistory()
    const srcNode = canvasNodes.find((n) => n.id === sourceNodeId)
    if (!srcNode) return

    let targetType = 'image-generate'
    let targetPort = 'referenceImage'
    const sourcePort = 'imageUrl'
    let extraInputs: Record<string, unknown> = {}
    let successMsg = ''

    const srcWidth = nodeWidthFor(srcNode.type)
    const targetX = snap(srcNode.x + srcWidth + 80, GRID_SIZE)
    let targetY = srcNode.y
    while (canvasNodes.some((n) => Math.abs(n.x - targetX) < 120 && Math.abs(n.y - targetY) < 90)) {
      targetY += 160
    }
    targetY = snap(targetY, GRID_SIZE)

    switch (actionType) {
      case 'remix':
        targetType = 'image-generate'
        targetPort = 'referenceImage'
        extraInputs = {
          prompt: srcNode.inputs.prompt ? `${srcNode.inputs.prompt}，同款高质感细节变体` : '同款高质感细节变体',
          model: srcNode.inputs.model,
          width: srcNode.inputs.width,
          height: srcNode.inputs.height,
          referenceImage: imageUrl,
        }
        successMsg = '已生成「同款变体」节点并自动连线'
        break

      case 'face-doodle':
        targetType = 'face-doodle'
        targetPort = 'image'
        extraInputs = {
          image: imageUrl,
          doodleMode: 'sketch',
          strokeColor: '#000000',
          strokeWidth: 4,
          strokeDensity: 3,
          edgeMargin: 4,
        }
        successMsg = '已生成「漫剧过脸」涂鸦节点并自动建立数据流'
        break

      case 'animate':
        targetType = 'video-generate'
        targetPort = 'image'
        extraInputs = {
          image: imageUrl,
          prompt: '画面细节自然动态流转，镜头缓慢微移，高质感运镜',
          duration: 5,
          fps: 24,
        }
        successMsg = '已生成「动效生视频」节点并自动连线'
        break

      case 'crop':
        targetType = 'image-crop'
        targetPort = 'image'
        extraInputs = {
          image: imageUrl,
          mode: 'free',
        }
        successMsg = '已生成「智能裁剪」节点并自动建立数据流'
        break

      case 'vision':
        targetType = 'llm-chat'
        targetPort = 'image'
        extraInputs = {
          prompt: '请作为资深视觉总监，详细解析这张图片的构图、主体特征、艺术风格、色彩搭配及可提炼的生图提示词（反推 Prompt）。',
          image: imageUrl,
        }
        successMsg = '已生成「视觉解读」AI 分析节点'
        break

      case 'upscale':
        targetType = 'image-generate'
        targetPort = 'referenceImage'
        extraInputs = {
          prompt: srcNode.inputs.prompt ? `${srcNode.inputs.prompt}，超高清细节重绘，8k分辨率，极致画质，主体特征保留` : '超高清细节重绘，8k分辨率，极致画质',
          referenceImage: imageUrl,
        }
        successMsg = '已生成「高清超分」重绘节点并自动连线'
        break
    }

    const newNodeId = createNode(targetType, targetX, targetY)

    try {
      tryConnect(sourceNodeId, sourcePort, newNodeId, targetPort)
    } catch {
      // 容错连接
    }

    setCanvasNodes((prev) =>
      prev.map((n) => {
        if (n.id === newNodeId) {
          return {
            ...n,
            inputs: {
              ...n.inputs,
              ...extraInputs,
            },
          }
        }
        return n
      })
    )

    selectNode(newNodeId)
    message.success(successMsg)
  }, [canvasNodes, createNode, tryConnect, selectNode, commitHistory])

  // 求批量语块数量 N：优先用最近一次执行输出，其次解析节点内字面量 JSON
  const getBatchCount = useCallback((batchNodeId: string): number => {
    const batchNode = canvasNodes.find((n) => n.id === batchNodeId)
    if (!batchNode) return 0
    const log = executionLogs.find((l) => l.nodeId === batchNodeId && l.status === 'success')
    const out = log?.output as Record<string, unknown> | undefined
    if (Array.isArray(out?.prompts)) return (out.prompts as unknown[]).length
    if (typeof out?.count === 'number') return out.count
    const { blocks } = parsePromptBlocks(batchNode.inputs.json, String(batchNode.inputs.field ?? 'prompt'))
    return blocks.length
  }, [canvasNodes, executionLogs])

  // 批量展开：根据 json-prompt-batch 的 N，自动创建/同步目标节点副本（第 i 份读第 i 个语块）
  // 返回本次新增的副本节点+连线，供调用方自动补跑它们
  const expandBatchNode = useCallback((
    batchNodeId: string,
    trigger?: { targetNodeId: string; targetPort: string },
    explicitN?: number
  ): { copies: CanvasNode[]; conns: Connection[] } | undefined => {
    let targetNodeId: string | undefined
    let targetPort: string | undefined
    if (trigger) {
      targetNodeId = trigger.targetNodeId
      targetPort = trigger.targetPort
    } else {
      const conn = connections.find((c) => c.sourceNodeId === batchNodeId && c.sourcePort === 'prompts')
      if (conn) {
        targetNodeId = conn.targetNodeId
        targetPort = conn.targetPort
      }
    }
    if (!targetNodeId || !targetPort) {
      message.warning('请先连接「提示词数组」输出到一个节点')
      return
    }
    const targetNode = canvasNodes.find((n) => n.id === targetNodeId)
    if (!targetNode) return

    const N = explicitN || getBatchCount(batchNodeId)
    if (!N || N < 2) {
      message.info('未解析到多个语块，请先运行工作流或填入含多套语块的 JSON')
      return
    }

    const existing = canvasNodes.filter((n) => n.batch?.sourceId === batchNodeId)

    // 删多余：index >= N 的副本及其连线
    const stale = existing.filter((n) => (n.batch?.index ?? 0) >= N)
    if (stale.length > 0) {
      const staleIds = new Set(stale.map((n) => n.id))
      setCanvasNodes((prev) => prev.filter((n) => !staleIds.has(n.id)))
      setConnections((prev) => prev.filter((c) => !staleIds.has(c.targetNodeId)))
    }

    // 主本与副本同步：主本取第 1 套语块（index 0），副本 index 1..N-1
    // 否则主本在主流程里会整传整个数组而非单取语块
    setConnections((prev) => prev.map((c) =>
      c.sourceNodeId === batchNodeId && c.sourcePort === 'prompts' && c.targetNodeId === targetNodeId
        ? { ...c, index: 0 }
        : c
    ))

    // 补缺失：index 1..N-1 缺哪个补哪个，克隆目标节点并建连线
    const addedCopies: CanvasNode[] = []
    const addedConns: Connection[] = []
    // 按节点真实高度算垂直间距（后端拿不到高度，用 DEFAULT_BATCH_LAYOUT）
    const layout = batchLayoutForHeight(estimateNodeHeight(nodeInfoMap.get(targetNode.type)))
    for (let i = 1; i < N; i++) {
      if (existing.some((n) => n.batch?.index === i)) continue
      const copyId = generateId('node')
      const copy: CanvasNode = {
        ...targetNode,
        id: copyId,
        label: `${targetNode.label} (${i + 1})`,
        // 位置计算收敛到 lib/canvas-batch（与后端同一公式，杜绝漂移）
        // 前端优势：能拿到节点真实高度 → 用 layoutForHeight 排得没有重叠
        ...batchCopyPosition({ x: targetNode.x, y: targetNode.y }, i, layout),
        batch: { sourceId: batchNodeId, index: i },
      }
      addedCopies.push(copy)
      setCanvasNodes((prev) => [...prev, copy])
      // 克隆其他指向原生图节点的输入连线(如 产品图→生图参考图),让每个副本都拿到同一组产品图
      const sharedInputs = connections.filter((c) => c.targetNodeId === targetNodeId && !(c.sourceNodeId === batchNodeId && c.sourcePort === 'prompts'))
      const newConns: Connection[] = [
        { id: generateId('conn'), sourceNodeId: batchNodeId, sourcePort: 'prompts', targetNodeId: copyId, targetPort, index: i },
        ...sharedInputs.map((c) => ({ id: generateId('conn'), sourceNodeId: c.sourceNodeId, sourcePort: c.sourcePort, targetNodeId: copyId, targetPort: c.targetPort, index: c.index })),
      ]
      addedConns.push(...newConns)
      setConnections((prev) => [
        ...prev,
        ...newConns,
      ])
    }
    message.success(`已展开为 ${N} 份`)
    return { copies: addedCopies, conns: addedConns }
  }, [canvasNodes, connections, executionLogs, getBatchCount, nodeInfoMap])

  const deleteConnectionById = useCallback((id: string) => {
    commitHistory()
    setConnections((prev) => prev.filter((c) => c.id !== id))
    deselectConnectionIfDeleted(id)
  }, [commitHistory])

  const updateNodeInput = useCallback((nodeId: string, key: string, value: unknown) => {
    commitHistory()
    setCanvasNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, inputs: { ...n.inputs, [key]: value } } : n)))
  }, [commitHistory])

  // ---- 节点卡片回调稳定化：CanvasNodeCard 是 React.memo，props 引用必须恒定，
  // 否则任一节点 setState 会全画布重渲染（上传大图时的卡顿放大器）。
  // 用 latest-ref 模式包一层 useCallback([])，内部转发到每帧最新的实现。
  const implRef = useRef({ handleNodeHeaderPointerDown, openNodeMenu, handlePortPointerDown, handlePortPointerUp })
  // 在 effect 里镜像（渲染期写 ref 会触发 react-hooks/refs）；只被稳定回调读取
  useEffect(() => {
    implRef.current = { handleNodeHeaderPointerDown, openNodeMenu, handlePortPointerDown, handlePortPointerUp }
  })
  const stableNodeHeaderPointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    implRef.current.handleNodeHeaderPointerDown(e, nodeId)
  }, [])
  const stableOpenNodeMenu = useCallback((point: { clientX: number; clientY: number }, nodeId: string, fromTouch?: boolean) => {
    implRef.current.openNodeMenu(point, nodeId, fromTouch)
  }, [])
  const stablePortPointerDown = useCallback((e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => {
    implRef.current.handlePortPointerDown(e, nodeId, portKey, side)
  }, [])
  const stablePortPointerUp = useCallback((e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => {
    implRef.current.handlePortPointerUp(e, nodeId, portKey, side)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Ctrl+S 保存(即使输入框内也触发)
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setWorkflowModalOpen(true)
        return
      }

      if (isTyping) return

      // Ctrl+A 全选所有节点
      if (e.ctrlKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (canvasNodes.length > 0) {
          setSelectedNodeIds(canvasNodes.map((n) => n.id))
        }
        return
      }

      // F 键自适应画布全貌 (Fit View)
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        fitView()
        return
      }

      // Ctrl+Z 撤销 / Ctrl+Shift+Z 或 Ctrl+Y 重做
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      // Ctrl+C 复制选中节点
      if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        copySelected()
        return
      }
      // Ctrl+D 一键原地克隆选中节点 (Duplicate)
      if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        copySelected()
        pasteClipboard()
        return
      }
      // Ctrl+V 粘贴
      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        // 焦点在图片粘贴区（image-upload 等 onPaste div）时放行，让浏览器触发 paste 粘贴图片
        if ((e.target as HTMLElement).closest('[data-paste-zone]')) return
        e.preventDefault()
        pasteClipboard()
        return
      }

      // Delete/Backspace：优先删选中连线，否则删选中节点(支持多选)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedConnectionId) {
          commitHistory()
          setConnections((prev) => prev.filter((c) => c.id !== selectedConnectionId))
          clearConnection()
        } else {
          deleteSelected()
        }
        return
      }

      // 方向键：精准移动选中节点(支持多选)。Shift = 大步(5格)，普通 = 1格
      const moveIds = selectedNodeIds.length > 0 ? selectedNodeIds : (selectedNodeId ? [selectedNodeId] : [])
      if (moveIds.length > 0) {
        const step = (e.shiftKey ? 5 : 1) * GRID_SIZE
        let dx = 0, dy = 0
        if (e.key === 'ArrowUp') dy = -step
        else if (e.key === 'ArrowDown') dy = step
        else if (e.key === 'ArrowLeft') dx = -step
        else if (e.key === 'ArrowRight') dx = step
        else return
        e.preventDefault()
        const idSet = new Set(moveIds)
        setCanvasNodes((prev) =>
          prev.map((n) =>
            idSet.has(n.id)
              ? { ...n, x: snap(n.x + dx, GRID_SIZE), y: snap(n.y + dy, GRID_SIZE) }
              : n
          )
        )
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deleteSelected, selectedNodeId, selectedConnectionId, selectedNodeIds, undo, copySelected, pasteClipboard, commitHistory])

  const clearCanvas = () => {
    commitHistory()
    setCanvasNodes([])
    setConnections([])
    clearSelection()
    setExecutionLogs([])
    setExecutionError(null)
  }

  const exportWorkflow = () => {
    // 自动收集运行素材：节点输入图片 + 运行日志输出图片
    const attachments = collectWorkflowAssets(canvasNodes, executionLogs)
    const workflow = {
      version: '1.0',
      type: 'aigc-hub-workflow',
      exportedAt: new Date().toISOString(),
      workflow: {
        name: workflowName || `工作流-${new Date().toLocaleDateString()}`,
        nodes: canvasNodes,
        connections,
        attachments,
      },
    }
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.workflow.name.replace(/[^a-zA-Z0-9一-龥]/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 载入工作流节点/连线：中小工作流一次性载入(React 自动批处理)，超大量节点才分帧渲染避免长任务卡 UI
  // 函数声明（非 const 箭头函数）：提升到作用域顶部，上方早声明的 effect/回调可直接调用而不触发 TDZ
  async function animateLoadNodes(nodes: CanvasNode[], conns: Connection[]) {
    commitHistory()
    setExecutionLogs([])
    setExecutionError(null)
    clearSelection()
    setSelectRect(null)
    setRunning(true)

    // 载入后自动排版：工具/工作流快照里的坐标常是作者随手摆的，直接载入会重叠错位。
    // 先按拓扑重排（用实测高度兜底估算），再让视口适配内容，用户一进来就能看全结构。
    const positions = autoLayoutRef.current?.(nodes, conns) ?? []
    const posById = new Map(positions.map((p) => [p.id, p]))
    const layouted = nodes.map((n) => {
      const p = posById.get(n.id)
      return p ? { ...n, x: p.x, y: p.y } : { ...n }
    })

    if (layouted.length > 80) {
      setCanvasNodes([])
      setConnections([])
      setLoadMsg(`正在加载工作流... ${layouted.length} 节点`)
      // 超大量节点：每帧放入一批并让出事件循环，避免一次性渲染大量节点卡顿
      const CHUNK = 20
      const chunked = layouted
      for (let i = 0; i < chunked.length; i += CHUNK) {
        const batch = chunked.slice(i, i + CHUNK)
        setCanvasNodes((prev) => [...prev, ...batch])
        await new Promise((r) => setTimeout(r, 16))
      }
      setConnections(conns)
    } else {
      setCanvasNodes(layouted)
      setConnections(conns)
    }
    setRunning(false)
    setLoadMsg('')
    // 排版后适配视口（等一帧让节点渲染完成再算边界）
    window.setTimeout(() => fitViewRef.current?.(), 80)
  }

  const loadWorkflow = async (workflow: WorkflowItem) => {
    setWorkflowModalOpen(false)
    setRunning(true) // 立即反馈：工具栏显示停止图标，节点开始逐个进入
    try {
      const res = await fetch(`/api/canvas-workflows/${workflow.id}`, { method: 'GET' })
      const data = await res.json()
      if (data.success) {
        setWorkflowName(data.data.name || workflow.name)
        setDemoAssets([])
        await animateLoadNodes(data.data.nodes as CanvasNode[], data.data.connections as Connection[])
      } else {
        message.error(data.message || '加载失败')
        setRunning(false)
      }
    } catch {
      message.error('加载失败，请重试')
      setRunning(false)
    }
  }

  const saveWorkflow = async () => {
    if (!workflowName.trim()) return
    setSavingWorkflow(true)
    try {
      const res = await apiFetch<{ name: string }>('/api/canvas-workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: workflowName.trim(),
          nodes: canvasNodes,
          connections,
        }),
      })
      if (res.success) {
        message.success(`工作流「${workflowName.trim()}」已保存`)
        setWorkflowModalOpen(false)
        setWorkflowName('')
        fetchWorkflows()
      } else {
        message.error(res.message || '保存失败，请稍后重试')
      }
    } catch {
      message.error('网络异常，保存失败')
    }
    finally { setSavingWorkflow(false) }
  }

  // 浏览器通知：收敛到 lib/browser-notify（原先画布/Copilot 各写一份，口径已漂移）。
  // 这里保持原行为：只在页面不可见时通知（notify 的默认策略即如此）。
  const notifyBrowser = (title: string, body: string) => notify(title, body)

  const runWorkflow = async (startNodeId?: string, options?: { executeNodeIds?: string[] }) => {
    const liveNodes = canvasNodesRef.current
    if (liveNodes.length === 0) return
    const connsRef = connections
    // 上次成功输出 → seedOutputs：缓存优先，有输出的上游不重跑、不重复扣费
    const seedOutputs: Record<string, Record<string, unknown>> = {}
    for (const l of executionLogsRef.current) {
      if (l.status === 'success' && l.output) seedOutputs[l.nodeId] = l.output
    }
    const nodesToRun = liveNodes
    let executeNodeIds: string[] | undefined

    if (options?.executeNodeIds?.length) {
      // 框选批量运行：只跑选中子集（走后端 executeNodeIds 增量通道），框外上游用缓存输出
      const liveIds = new Set(liveNodes.map((n) => n.id))
      executeNodeIds = options.executeNodeIds.filter((id) => liveIds.has(id))
      if (executeNodeIds.length === 0) return
    } else if (startNodeId) {
      // 单节点运行：只跑「该节点 + 缺缓存输出的上游」；上游已有输出直接复用（不重跑不扣费）
      const upstream = new Set<string>()
      const collect = (id: string) => {
        if (upstream.has(id)) return
        upstream.add(id)
        for (const c of connsRef) {
          if (c.targetNodeId === id) collect(c.sourceNodeId)
        }
      }
      collect(startNodeId)
      const needRun = [...upstream].filter((id) => id === startNodeId || seedOutputs[id] === undefined)
      const liveSet = new Set(liveNodes.map((n) => n.id))
      const runnable = needRun.filter((id) => liveSet.has(id))
      if (runnable.length === 0) return
      if (runnable.length > 1) {
        // 上游缺缓存：绝不静默连带跑，弹确认（用户批准后才跑上游并计费）
        const upCount = runnable.length - 1
        const names = liveNodes
          .filter((n) => runnable.includes(n.id) && n.id !== startNodeId)
          .map((n) => n.label || nodeInfoMap.get(n.type)?.label || n.type)
          .slice(0, 3)
          .join('、')
        const ok = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: '上游节点没有运行结果',
            content: `运行该节点需要「${names}${upCount > 3 ? ` 等 ${upCount} 个` : ''}」上游节点的输出。要先运行这些上游节点吗？（会消耗相应积分）`,
            okText: '运行上游节点',
            cancelText: '取消',
            centered: true,
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          })
        })
        if (!ok) return
      }
      executeNodeIds = runnable
    }
    setRunning(true)
    setExecutionLogs([])
    setExecutionError(null)
    // P6: 生成 runId 传给后端做画布任务持久化（支持暂停/取消/恢复/重试）
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/canvas/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes: nodesToRun, connections: connsRef, runId, seedOutputs, executeNodeIds }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        if (res.status === 401) {
          message.error('登录已失效，请重新登录')
          window.location.href = '/login'
          return
        }
        const data = await res.json().catch(() => ({ message: '请求失败' }))
        setExecutionError(data.message || '请求失败')
        setRunning(false)
        return
      }

      // 解析收敛到 lib/sse（唯一实现）：此前这里手写 buffer 拆分，
      // 与 useToolRunStore / CopilotPanel 各写一份，协议一改就要改三处。
      // res.body 在上面的 !res.body 判断里已保证非空。
      await consumeSseStream(res.body, async (raw) => {
        const event = raw as unknown as CanvasSseEvent
        if (event.type === 'nodeStart') {
          setExecutionLogs((prev) => [...prev, { nodeId: event.nodeId, status: 'running' }])
        } else if (event.type === 'nodePhase') {
          // 上游相位：排队（等待派发）/ 已发出（生成中）。与工具箱成果区同一套语义。
          setExecutionLogs((prev) =>
            prev.map((log) =>
              log.nodeId === event.nodeId
                ? { ...log, status: 'running', output: { progress: event.phase === 'running' ? '生成中…' : '等待派发…' } }
                : log
            )
          )
        } else if (event.type === 'nodeProgress') {
          // 中间过程信号（如「生成图像中...」）：展示进度但节点仍为运行中
          setExecutionLogs((prev) =>
            prev.map((log) =>
              log.nodeId === event.nodeId
                ? { ...log, status: 'running', output: { progress: event.message } }
                : log
            )
          )
        } else if (event.type === 'nodeOutput') {
          setExecutionLogs((prev) =>
            prev.map((log) =>
              log.nodeId === event.nodeId
                ? { ...log, status: 'success', output: event.output }
                : log
            )
          )
        } else if (event.type === 'nodeError') {
          setExecutionLogs((prev) =>
            prev.map((log) =>
              log.nodeId === event.nodeId
                ? { ...log, status: 'error', error: event.error }
                : log
            )
          )
        } else if (event.type === 'error') {
          setExecutionError(event.message)
          notifyBrowser('工作流执行出错', event.message || '请查看执行面板')
        } else if (event.type === 'cancelled') {
          setExecutionError('执行已取消')
          setRunning(false)
        } else if (event.type === 'paused') {
          setExecutionError('执行已暂停，可在执行面板恢复')
          setRunning(false)
        } else if (event.type === 'batchExpanded') {
          // 后端已就地展开并执行副本：同步画布（主本连线 index 0 + 副本节点/连线）
          setConnections((prev) => prev.map((c) => c.id === event.mainConnId ? { ...c, index: 0 } : c))
          setCanvasNodes((prev) => [...prev, ...((event.copies || []) as unknown as CanvasNode[])])
          setConnections((prev) => [...prev, ...((event.conns || []) as unknown as Connection[])])
        } else if (event.type === 'done') {
          // execution complete → 浏览器通知 + 通知 Copilot 自动分析
          notifyBrowser('工作流运行完成', `全部节点执行完毕，共 ${canvasNodesRef.current.length} 个节点`)
          emitWorkflowExecuted({
            logs: executionLogsRef.current.filter((log): log is { nodeId: string; status: 'success' | 'error'; error?: string } =>
              log.status !== 'running'
            ),
            error: undefined
          })
        }
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      const errMsg = err instanceof Error ? err.message : '执行请求失败'
      setExecutionError(errMsg)
      notifyBrowser('工作流执行出错', errMsg)
      emitWorkflowExecuted({
        logs: executionLogsRef.current.filter((log): log is { nodeId: string; status: 'success' | 'error'; error?: string } =>
          log.status !== 'running'
        ),
        error: errMsg
      })
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const stopWorkflow = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  // 演示模拟：用演示素材填充节点输入 → 模拟依次运行(不调API/不扣积分)
  const runDemoSimulation = () => {
    if (canvasNodes.length === 0) return
    if (demoAssets.length === 0) {
      message.info('当前工作流无演示素材，仅模拟节点运行')
    }
    setRunning(true)
    setExecutionLogs([])
    setExecutionError(null)

    // 1. 用演示素材填充节点输入(图片上传/图片类节点塞图, 文本输入节点塞文字)
    setCanvasNodes((prev) =>
      prev.map((n) => {
        const inAssets = demoAssets.filter((a) => a.nodeId === n.id && a.role === 'input')
        const inputs = { ...n.inputs }
        if (inAssets.length > 0) {
          const url = inAssets[0].url
          if (['image-upload', 'image-preview', 'image-crop', 'image-generate', 'nine-grid-loop', 'grid9-to-gif', 'llm-chat'].includes(n.type)) {
            if (n.type === 'nine-grid-loop') {
              inputs.referenceImage = url
            } else {
              inputs.image = url
              if (n.type !== 'llm-chat' && n.type !== 'image-generate') inputs.imageUrl = url
            }
          }
        }
        if (n.type === 'text-input' && !inputs.content) {
          inputs.content = '（演示）这是一段用于演示的输入文本。'
        }
        if (n.type === 'llm-chat' && !inputs.prompt) {
          inputs.prompt = '（演示）请分析这段内容。'
        }
        return { ...n, inputs }
      })
    )

    // 2. 按拓扑序依次生成假执行日志
    const sorted = demoTopoSort(canvasNodes, connections)
    sorted.forEach((n, i) => {
      window.setTimeout(() => {
        const outAssets = demoAssets.filter((a) => a.nodeId === n.id && a.role === 'output')
        const output = genDemoOutput(n, outAssets)
        setExecutionLogs((prev) => [...prev, { nodeId: n.id, status: 'success', output }])
      }, 600 * (i + 1))
    })

    window.setTimeout(() => {
      setRunning(false)
      message.success('演示模拟完成（未消耗积分）')
    }, 600 * sorted.length + 400)
  }

  // 节点执行状态(用于连线/边框着色)
  const nodeStatusMap = (nodeId: string) => getNodeStatus(nodeId, executionLogs)

  // 拖拽连线时源端口类型(用于输入端口高亮/淡化反馈)
  const dragSourceType = drag.type === 'connection'
    ? (() => {
        const srcN = canvasNodes.find((n) => n.id === drag.sourceNodeId)
        return srcN ? nodeInfoMap.get(srcN.type)?.outputs?.[drag.sourcePort]?.type : undefined
      })()
    : undefined

  // 自动排版
  const { autoLayout, alignNodes, distributeNodes, tidySelectedNodes } = useAutoLayout(
    (id) => {
      const n = canvasNodes.find((nn) => nn.id === id)
      return n ? { x: n.x, y: n.y } : { x: 0, y: 0 }
    },
    (id, x, y) => setCanvasNodes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n))),
    (id) => {
      const n = canvasNodes.find((nn) => nn.id === id)
      if (!n) return 120
      const info = nodeInfoMap.get(n.type)
      let h = estimateNodeHeight(info)
      // image-crop:缩略图 + 工作台按钮 + 状态行 + 边距
      if (n.type === 'image-crop' && (n.inputs.imageUrl || n.inputs.image)) {
        h += 190
      }
      // face-doodle:缩略图 + 工作台按钮 + 框数行 + 边距（与 image-crop 同构）
      if (n.type === 'face-doodle' && (n.inputs.imageUrl || n.inputs.image)) {
        h += 190
      }
      // image-preview / image-generate:运行后有输出图片块
      if (n.type === 'image-preview' || n.type === 'image-generate' || n.type === 'nine-grid-loop' || n.type === 'grid9-to-gif') {
        const log = executionLogs.find((l) => l.nodeId === id && l.status === 'success')
        const out = log?.output as Record<string, unknown> | undefined
        if (out?.imageUrl || out?.gifUrl) h += 184 // 输出图片 max-h-40 + 边距
        else if (Array.isArray(out?.images)) h += 12 + Math.ceil((out.images as unknown[]).length / 3) * 72
      }
      return h
    },
    (id) => canvasNodes.find((nn) => nn.id === id)?.type,
  )
  // 回填 ref：animateLoadNodes（声明更早）通过 ref 调用，绕开 TDZ。
  // 传入节点对象（含 type），布局内部按类型取宽度、按估算高度取高度。
  useEffect(() => {
    autoLayoutRef.current = (list, conns) =>
      autoLayout(list, conns, { direction: 'LR', maxPerColumn: 6 }) ?? []
    expandBatchNodeRef.current = expandBatchNode
  })
  // Copilot 操作集（在 runWorkflow/clearCanvas 定义之后构建，避免 TDZ）
  const canvasOps = {
    createNode, deleteNode: deleteNodeById, connectNodes: connectNodesOp,
    deleteConnection: deleteConnectionById, updateNodeInput, runWorkflow,
    selectNode, clearCanvas,
    getCanvasState: () => {
      const { nodes: csNodes, connections: csConns } = canvasStateRef.current
      return {
        nodes: csNodes.map((n) => ({
          id: n.id,
          type: n.type,
          label: n.label,
          category: n.category,
          inputs: n.inputs,
          outputs: n.outputs,
          status: getNodeStatus(n.id, executionLogs),
        })),
        connections: csConns.map((c) => ({
          id: c.id, sourceNodeId: c.sourceNodeId, sourcePort: c.sourcePort,
          targetNodeId: c.targetNodeId, targetPort: c.targetPort,
        })),
        selectedNodeIds: selectedNodeIds.length > 0 ? selectedNodeIds : (selectedNodeId ? [selectedNodeId] : []),
      }
    },
    // 确定性画布健康检查(Copilot 闭环观察用)
    getCanvasHealthCheck: () => {
      const { nodes: csNodes, connections: csConns } = canvasStateRef.current
      const result = checkCanvasHealth(csNodes, csConns, (n) => {
        const info = getEffectiveNodeInfo(n as CanvasNode, nodeInfoMap.get(n.type), modelOptions)
        return info ? { inputs: info.inputs, outputs: info.outputs } : undefined
      })
      return result.summary
    },
    autoLayout: (ids: string[]) => {
      if (ids && ids.length > 0) {
        tidySelectedNodes(ids, connections, { direction: 'LR' })
      } else {
        autoLayout(canvasNodes.map((n) => n.id), connections, { direction: 'LR' })
      }
    },
    getExecutionLogs: () => executionLogs,
    deleteConnectionByPorts: (sourceId: string, sourcePort: string, targetId: string, targetPort: string) => {
      setConnections((prev) => prev.filter(
        (c) => !(c.sourceNodeId === sourceId && c.sourcePort === sourcePort && c.targetNodeId === targetId && c.targetPort === targetPort)
      ))
    },
    restoreSnapshot: (nodes: unknown[], connections: unknown[]) => {
      setCanvasNodes(nodes as CanvasNode[])
      setConnections(connections as Connection[])
    },
    // Copilot 高亮被改动的节点(3s 后清除)
    highlightNodes: (ids: string[]) => {
      setHighlightIds(ids)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => setHighlightIds([]), 3000)
    },
    // Copilot 计划幽灵预览(虚线呈现规划节点/连线;null 清除)
    setGhost: (g: { nodes: { id: string; nodeType: string }[]; connections: { sourceId: string; sourcePort: string; targetId: string; targetPort: string }[] } | null) => {
      setGhostState(g)
    },
  }

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const pendingPanelRef = useRef<string | null>(null)
  const panelNode = panelOpenNodeId ? canvasNodes.find((n) => n.id === panelOpenNodeId) ?? null : null
  const selectedNode = canvasNodes.find((n) => n.id === selectedNodeId)
  const selectedInfo = panelNode ? getEffectiveNodeInfo(panelNode, nodeInfoMap.get(panelNode.type), modelOptions) : undefined
  // 全画布节点的有效端口信息查表（含模型能力动态端口）：一次 useMemo 替代渲染循环里逐节点分配新对象，
  // 配合 React.memo(CanvasNodeCard) 让无关节点的 props.info 引用保持稳定
  const effectiveInfos = useMemo(() => {
    const m = new Map<string, NodeInfo | undefined>()
    for (const n of canvasNodes) m.set(n.id, getEffectiveNodeInfo(n, nodeInfoMap.get(n.type), modelOptions))
    return m
  }, [canvasNodes, nodeInfoMap, modelOptions])

  // 实测各节点卡片高度：ResizeObserver 批量跟随（内容变化即更新，连线/端口对位用）
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(new Map())

  // 画布容器尺寸/位置跟随：Minimap 与旧面板定位需要，渲染期读 ref 会触发 react-hooks/refs
  useEffect(() => {
    const container = canvasRef.current
    if (!container) return
    const sync = () => {
      const r = container.getBoundingClientRect()
      setCanvasBox((prev) => (
        prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height }
      ))
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(container)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [])

  useEffect(() => {
    const container = canvasRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      setMeasuredHeights((prev) => {
        const next = new Map(prev)
        let changed = false
        for (const e of entries) {
          const el = e.target as HTMLElement
          const id = el.getAttribute('data-canvas-node-id')
          if (!id) continue
          const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight)
          if (h > 0 && next.get(id) !== h) { next.set(id, h); changed = true }
        }
        return changed ? next : prev
      })
    })
    container.querySelectorAll('[data-canvas-node-id]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [canvasNodes])

  // 节点高度查表：估算兜底 + 实测高度优先（结果卡身内容撑高后连线锚点跟随，短文本不留白板）
  const nodeHeights = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of canvasNodes) {
      const info = effectiveInfos.get(n.id)
      m.set(n.id, estimateNodeHeight(info, visibleInputKeys(n.type, info).length, Object.keys(info?.outputs ?? {}).length, n.type))
    }
    for (const [id, h] of measuredHeights) m.set(id, h)
    return m
  }, [canvasNodes, effectiveInfos, measuredHeights])

  // 节点的参考图候选：解析连入 referenceImage 端口的上游输出（优先运行结果，回退源节点自身输入——上游未运行也能预览到图）
  const refImagesFor = useCallback((nodeId: string): string[] => {
    const valid = (v: unknown): v is string => typeof v === 'string' && /^(data:image|https?:|\/)/.test(v)
    const imgs: string[] = []
    for (const c of connections.filter((c) => c.targetNodeId === nodeId && c.targetPort === 'referenceImage')) {
      const log = [...executionLogs].reverse().find((l) => l.nodeId === c.sourceNodeId && l.status === 'success')
      const out = (log?.output ?? {}) as Record<string, unknown>
      const srcNode = canvasNodes.find((n) => n.id === c.sourceNodeId)
      const srcIns = (srcNode?.inputs ?? {}) as Record<string, unknown>
      const val = out[c.sourcePort] ?? srcIns[c.sourcePort] ?? out.imageUrl ?? out.image ?? srcIns.image ?? srcIns.imageUrl
      if (valid(val)) imgs.push(val)
      else if (Array.isArray(val)) {
        const arr = val.filter(valid)
        if (c.index !== undefined) { if (valid(arr[c.index])) imgs.push(arr[c.index]) }
        else arr.forEach((v) => imgs.push(v))
      }
    }
    return imgs
  }, [connections, executionLogs, canvasNodes])
  const selectedRefImages = panelNode && (panelNode.type === 'image-generate' || panelNode.type === 'nine-grid-loop') ? refImagesFor(panelNode.id) : []

  // 节点卡身直传：单图节点压缩后写 inputs.image，批量节点走合帧队列
  const handleNodeUploadFiles = useCallback((node: CanvasNode, files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (list.length === 0) { message.error('请选择图片文件'); return }
    if (node.type === 'image-upload-batch') {
      for (const f of list) {
        if (isImageFileTooLarge(f)) { message.error(`图片 ${f.name} 超过 20MB，已跳过`); continue }
        const reader = new FileReader()
        reader.onload = () => enqueueImage(node.id, reader.result as string, setCanvasNodes)
        reader.onerror = () => message.error('读取图片失败')
        reader.readAsDataURL(f)
      }
      return
    }
    const f = list[0]
    if (isImageFileTooLarge(f)) { message.warning('图片超过 20MB，请压缩后再上传'); return }
    const reader = new FileReader()
    reader.onload = async () => {
      const compressed = await compressImageDataUrl(reader.result as string)
      commitHistory()
      setCanvasNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, inputs: { ...n.inputs, image: compressed } } : n)))
    }
    reader.onerror = () => message.error('读取图片失败')
    reader.readAsDataURL(f)
  }, [commitHistory, message])

  // 参数面板停靠位置：布局完成后测量节点卡片底边，节点增高/画布平移时跟随（所有节点统一停靠正下方）
  const [imgGenPanelPos, setImgGenPanelPos] = useState<{ left: number; top: number } | null>(null)
  const selectedNodeForPanel = panelNode
  // useLayoutEffect：与节点拖拽同帧更新，面板紧跟不脱节
  useLayoutEffect(() => {
    if (!selectedNodeForPanel || !canvasRef.current) {
      setImgGenPanelPos(null)
      return
    }
    const nodeId = selectedNodeForPanel.id
    const measure = () => {
      const container = canvasRef.current
      const el = container?.querySelector(`[data-canvas-node-id="${nodeId}"]`)
      if (!container || !el) return
      const cRect = container.getBoundingClientRect()
      const r = (el as HTMLElement).getBoundingClientRect()
      const panelW = ((panelNode.type === 'image-generate' || panelNode.type === 'nine-grid-loop' || panelNode.type === 'grid9-to-gif') ? 400 : 260) * viewport.scale
      // 左缘对齐节点左缘（边缘钳制）；底部钳制：小屏时面板不超出画布容器
      const maxTop = container.clientHeight - 220
      setImgGenPanelPos({
        left: Math.min(Math.max(r.left - cRect.left, 8), Math.max(0, container.clientWidth - panelW - 8)),
        top: Math.min(r.bottom - cRect.top + 8, Math.max(8, maxTop)),
      })
    }
    measure()
    const el = canvasRef.current.querySelector(`[data-canvas-node-id="${nodeId}"]`)
    const ro = el ? new ResizeObserver(measure) : null
    if (ro && el) ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [selectedNodeForPanel, canvasNodes, viewport, executionLogs])

  // 选中图片上传节点时，自动聚焦属性面板的上传粘贴区：Ctrl+V 直接粘贴，无需点上传区(点了会弹文件选择框)
  // preventScroll 必须：focus 默认会滚动祖先容器把目标滚进视野，上传完成后 setState 重触发本 effect，
  // 反复滚动整个页面导致「界面上移、胶囊悬空、顶部菜单看不到」的布局崩坏
  // 使用 ref 避免 upload 后 setCanvasNodes 重复触发 effect 导致反复 focus/滚动
  const uploadFocusedRef = useRef(false)
  useEffect(() => {
    // 当 selectedNode 切换到非图片上传类型时，重置 ref 以便下次选中时再次聚焦
    if (
      selectedNode &&
      (selectedNode.type === 'image-upload' || selectedNode.type === 'image-upload-batch')
    ) {
      uploadFocusedRef.current = false
    }
    if (
      selectedNode &&
      (selectedNode.type === 'image-upload' || selectedNode.type === 'image-upload-batch') &&
      !uploadFocusedRef.current
    ) {
      uploadFocusedRef.current = true
      const t = setTimeout(() => {
        (document.querySelector('[data-paste-zone]') as HTMLElement | null)?.focus({ preventScroll: true })
      }, 80)
      return () => clearTimeout(t)
    }
  }, [selectedNode])

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* 三库下拉面板：两级 hover 级联（hover 库按钮 → 分类 → 右侧详情），由 CatalogPanel 用 portal 渲染到 body，脱离画布 transform */}
      <CatalogPanel
        mode={catalogMode === 'workflows' ? 'nodes' : catalogMode}
        open={catalogOpen}
        pinned={catalogPinned}
        anchorRect={catalogAnchorRect}
        groupedNodes={groupedNodes}
        toolTemplates={TOOL_TEMPLATES}
        remoteTools={remoteTools}
        onImportRemoteTool={importRemoteTool}
        presetTemplates={PRESET_TEMPLATES}
        promptLibItems={promptLibItems}
        promptLibLoading={promptLibLoading}
        onClose={closeCatalog}
        onSetPinned={(p) => setCatalogPinned(p)}
        onAreaEnter={catalogHoverOpen}
        onAreaLeave={catalogHoverClose}
        onUseTool={openTool}
        onImportPreset={importPreset}
        onDragNodeStart={handleCatalogDragStart}
        onTapNode={handleCatalogTap}
      />

      {/* Center: Canvas */}
      <div className="flex-1 relative overflow-hidden bg-surface-hover" ref={canvasRef} onDoubleClick={handleCanvasBackgroundDoubleClick}>
        {/* 加载工作流进度提示(系统统一 Loading 动画) */}
        {loadMsg && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50 pointer-events-none">
            <Loading tip={loadMsg} size={56} />
          </div>
        )}
        {/* Grid background */}
        <div
          data-canvas-background
          className="absolute inset-0 canvas-touch-surface"
          style={{
            backgroundImage: `
              linear-gradient(to right, var(--border-color) 1px, transparent 1px),
              linear-gradient(to bottom, var(--border-color) 1px, transparent 1px)
            `,
            backgroundSize: `${GRID_SIZE * viewport.scale}px ${GRID_SIZE * viewport.scale}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
          onPointerDown={handlePointerDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />

        {/* World transform container —— 节点和连线所在层;空白点击取消选中 */}
        <div
          data-canvas-background
          className="absolute top-0 left-0 origin-top-left canvas-touch-surface"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
        {dragOver && (
          <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary pointer-events-none z-50 flex items-center justify-center">
            <Text className="text-primary font-medium">释放以创建节点</Text>
          </div>
        )}

          {/* 框选矩形(世界坐标) */}
          {selectRect && (
            <div
              className="absolute border-2 border-primary bg-primary/10 pointer-events-none z-40"
              style={{ left: selectRect.x, top: selectRect.y, width: selectRect.w, height: selectRect.h }}
            />
          )}

          {/* 便签层：节点与连线下方，独立于 DAG 拓扑（不入执行器，仅辅助注释） */}
          {stickyNotes.map((note) => {
            const noteColors: Record<string, { bg: string; border: string; accent: string }> = {
              yellow: { bg: 'bg-yellow-100/95', border: 'border-yellow-300/80', accent: 'text-yellow-700' },
              pink: { bg: 'bg-pink-100/95', border: 'border-pink-300/80', accent: 'text-pink-700' },
              blue: { bg: 'bg-blue-100/95', border: 'border-blue-300/80', accent: 'text-blue-700' },
              green: { bg: 'bg-green-100/95', border: 'border-green-300/80', accent: 'text-green-700' },
              orange: { bg: 'bg-orange-100/95', border: 'border-orange-300/80', accent: 'text-orange-700' },
            }
            const c = noteColors[note.color] || noteColors.yellow
            const isEditing = editingNoteId === note.id
            return (
              <div
                key={note.id}
                className={`absolute rounded-lg ${c.bg} ${c.border} border shadow-md z-10 group`}
                style={{ left: note.x, top: note.y, width: note.width, height: note.height, transform: 'rotate(-0.5deg)' }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingNoteId(isEditing ? null : note.id)
                }}
              >
                {/* 拖动：点住便签上半区头部空白 */}
                <div
                  className="absolute inset-x-0 top-0 h-6 cursor-move"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    const startX = e.clientX
                    const startY = e.clientY
                    const ox = note.x
                    const oy = note.y
                    const move = (ev: PointerEvent) => {
                      const dx = (ev.clientX - startX) / viewport.scale
                      const dy = (ev.clientY - startY) / viewport.scale
                      updateStickyNote(note.id, { x: ox + dx, y: oy + dy })
                    }
                    const up = () => {
                      window.removeEventListener('pointermove', move)
                      window.removeEventListener('pointerup', up)
                      setStickyNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, x: snap(n.x, GRID_SIZE), y: snap(n.y, GRID_SIZE) } : n))
                      commitHistory()
                    }
                    window.addEventListener('pointermove', move)
                    window.addEventListener('pointerup', up)
                  }}
                />

                {/* 颜色小圆点 + 删除按钮 */}
                <div className="absolute top-1.5 left-2 flex gap-1">
                  {(['yellow', 'pink', 'blue', 'green', 'orange'] as const).map((cc) => (
                    <button
                      key={cc}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); updateStickyNote(note.id, { color: cc }) }}
                      title={`切换颜色: ${cc}`}
                      className={`size-2.5 rounded-full border transition-transform ${note.color === cc ? 'ring-2 ring-black/40 scale-110' : 'opacity-70 hover:scale-110'}`}
                      style={{
                        backgroundColor: { yellow: '#fde68a', pink: '#fbcfe8', blue: '#bfdbfe', green: '#bbf7d0', orange: '#fed7aa' }[cc],
                      }}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteStickyNote(note.id) }}
                  title="删除便签"
                  className="absolute top-1.5 right-1.5 z-10 size-5 hidden group-hover:grid place-items-center rounded-full bg-black/10 text-black/60 hover:bg-black/20 transition-colors"
                >
                  <CloseOutlined className="text-[9px]" />
                </button>

                {/* 右下角 resize 手柄 */}
                <div
                  className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    const startX = e.clientX
                    const startY = e.clientY
                    const ow = note.width
                    const oh = note.height
                    const move = (ev: PointerEvent) => {
                      const dx = (ev.clientX - startX) / viewport.scale
                      const dy = (ev.clientY - startY) / viewport.scale
                      updateStickyNote(note.id, { width: Math.max(120, ow + dx), height: Math.max(80, oh + dy) })
                    }
                    const up = () => {
                      window.removeEventListener('pointermove', move)
                      window.removeEventListener('pointerup', up)
                      commitHistory()
                    }
                    window.addEventListener('pointermove', move)
                    window.addEventListener('pointerup', up)
                  }}
                />

                {/* 内容文本区 */}
                <textarea
                  value={note.text}
                  placeholder="记录灵感、Prompt 或评审意见…"
                  onChange={(e) => updateStickyNote(note.id, { text: e.target.value })}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="w-full h-full resize-none bg-transparent p-2 pt-7 text-[11px] leading-relaxed outline-none placeholder:text-black/30"
                  style={{ fontFamily: 'inherit' }}
                />
              </div>
            )
          })}

          {/* 多选浮出工具条：跟随选中包围盒顶部（世界坐标，随画布平移缩放） */}
          {(() => {
            const selNodes = canvasNodes.filter((n) => selectedNodeIds.includes(n.id))
            if (selNodes.length === 0 || quickPicker) return null
            let minX = Infinity, minY = Infinity, maxX = -Infinity
            for (const n of selNodes) {
              minX = Math.min(minX, n.x)
              minY = Math.min(minY, n.y)
              maxX = Math.max(maxX, n.x + nodeWidthFor(n.type))
            }
            return (
              <div
                className="absolute z-50 flex items-center gap-1.5 rounded-full glass-panel px-3 py-1.5 shadow-xl border border-white/20 backdrop-blur-md"
                style={{ left: Math.max(0, minX + (maxX - minX) / 2 - 140), top: minY - 50 }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="text-[11px] font-medium text-text-secondary px-1 whitespace-nowrap">
                  已选 {selNodes.length}
                </span>

                {selNodes.length >= 2 && (
                  <>
                    <Dropdown
                      menu={{
                        items: [
                          { key: 'left', icon: <AlignLeftOutlined />, label: '左对齐' },
                          { key: 'center', icon: <AlignCenterOutlined />, label: '水平居中' },
                          { key: 'right', icon: <AlignRightOutlined />, label: '右对齐' },
                          { type: 'divider' },
                          { key: 'top', icon: <VerticalAlignTopOutlined />, label: '顶端对齐' },
                          { key: 'middle', icon: <VerticalAlignMiddleOutlined />, label: '垂直居中' },
                          { key: 'bottom', icon: <VerticalAlignBottomOutlined />, label: '底端对齐' },
                        ],
                        onClick: ({ key }) => {
                          commitHistory()
                          alignNodes(selectedNodeIds, key as AlignType)
                          message.success('已完成对齐')
                        },
                      }}
                      trigger={['click']}
                    >
                      <Button size="small" type="text" icon={<AlignCenterOutlined />} title="对齐方式">
                        <span className="text-xs">对齐</span>
                      </Button>
                    </Dropdown>

                    {selNodes.length >= 3 && (
                      <Dropdown
                        menu={{
                          items: [
                            { key: 'horizontal', icon: <ColumnWidthOutlined />, label: '水平等间距分布' },
                            { key: 'vertical', icon: <ColumnHeightOutlined />, label: '垂直等间距分布' },
                          ],
                          onClick: ({ key }) => {
                            commitHistory()
                            distributeNodes(selectedNodeIds, key as DistributeDirection)
                            message.success('已完成等距分布')
                          },
                        }}
                        trigger={['click']}
                      >
                        <Button size="small" type="text" icon={<ColumnWidthOutlined />} title="等间距分布">
                          <span className="text-xs">分布</span>
                        </Button>
                      </Dropdown>
                    )}

                    <Tooltip title="按数据流整理选中节点（原地优雅排布）">
                      <Button
                        size="small"
                        type="text"
                        icon={<AppstoreOutlined className="text-accent" />}
                        onClick={() => {
                          commitHistory()
                          tidySelectedNodes(selectedNodeIds, connections, { direction: 'LR' })
                          message.success('已整理选中节点排布')
                        }}
                      >
                        <span className="text-xs">整理</span>
                      </Button>
                    </Tooltip>

                    <div className="h-3 w-px bg-white/20 mx-0.5" />
                  </>
                )}

                <Button
                  type="primary"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  loading={running}
                  onClick={() => runWorkflow(undefined, { executeNodeIds: selectedNodeIds })}
                >
                  <span className="text-xs">运行</span>
                </Button>
                <Button size="small" icon={<CopyOutlined />} onClick={() => { copySelected(); pasteClipboard() }} title="复制选中节点" />
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => { deleteSelected() }} title="删除选中节点" />
              </div>
            )
          })()}

          {/* Connections SVG —— 铺设大尺寸 + overflow:visible 确保所有 path 可见；pointerEvents:none 不拦截 mouseup */}
          <svg className="absolute top-0 left-0" style={{ width: '20000px', height: '20000px', overflow: 'visible', pointerEvents: 'none' }}>
            {connections.map((conn) => {
              const source = canvasNodes.find((n) => n.id === conn.sourceNodeId)
              const target = canvasNodes.find((n) => n.id === conn.targetNodeId)
              if (!source || !target) return null

              const sourceInfo = getEffectiveNodeInfo(source, nodeInfoMap.get(source.type), modelOptions)
              const targetInfo = getEffectiveNodeInfo(target, nodeInfoMap.get(target.type), modelOptions)
              const start = getPortPosition(source, conn.sourcePort, 'output', sourceInfo, source.type, nodeHeights.get(source.id))
              const end = getPortPosition(target, conn.targetPort, 'input', targetInfo, target.type, nodeHeights.get(target.id))
              const d = getBezierPath(start.x, start.y, end.x, end.y)
              const isSelected = selectedConnectionId === conn.id
              // 连线默认按源端口类型着色，执行/选中时用状态色覆盖
              const srcStatus = nodeStatusMap(conn.sourceNodeId)
              const srcTypeColor = typeColors[sourceInfo?.outputs?.[conn.sourcePort]?.type || 'string'] || '#8C8C8C'
              const linkColor = isSelected ? 'var(--primary)' : (srcStatus !== 'idle' ? statusColors[srcStatus] : srcTypeColor)
              const isRunning = srcStatus === 'running'
              return (
                <g
                  key={conn.id}
                  style={{ pointerEvents: 'all' }}
                  onClick={() => selectConnection(conn.id)}
                  data-conn-id={conn.id}
                  data-src-node={conn.sourceNodeId}
                  data-src-port={conn.sourcePort}
                  data-tgt-node={conn.targetNodeId}
                  data-tgt-port={conn.targetPort}
                >
                  {/* 透明粗 path 垫底，扩大命中区 */}
                  <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }} />
                  <path
                    d={d}
                    fill="none"
                    stroke={linkColor}
                    strokeWidth={isSelected ? 3 : 2.5}
                    strokeDasharray={isRunning ? '8 4' : undefined}
                    style={{ pointerEvents: 'none', cursor: 'pointer', animation: isRunning ? 'dashFlow 1s linear infinite' : undefined }}
                  />
                </g>
              )
            })}

            {drag.type === 'connection' && (() => {
              const source = canvasNodes.find((n) => n.id === drag.sourceNodeId)
              if (!source) return null
              const start = getPortPosition(source, drag.sourcePort, 'output', getEffectiveNodeInfo(source, nodeInfoMap.get(source.type), modelOptions), source.type, nodeHeights.get(source.id))
              const end = screenToCanvas(drag.endX - canvasBox.left, drag.endY - canvasBox.top)
              return (
                <path
                  d={getBezierPath(start.x, start.y, end.x, end.y)}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  strokeDasharray="5,5"
                />
              )
            })()}
          </svg>

          {/* Nodes */}
          {canvasNodes.map((node) => {
            const nodeLog = executionLogs.find((l) => l.nodeId === node.id && l.status === 'success')
            // 裁切/涂鸦节点：解析要显示的图片（自身值 → 上游运行结果 → 上游节点输入值）
            // 裁切卡身已内联（ImageCropBody），cropImageUrl 回退自身 output.images[0] 兜底预览
            let cropImageUrl = ''
            if (node.type === 'image-crop' || node.type === 'face-doodle') {
              if (Array.isArray(nodeLog?.output?.images) && nodeLog.output.images.length > 0) {
                cropImageUrl = String(nodeLog.output.images[0])
              }
              const ownUrl = String(node.inputs.imageUrl ?? '')
              if (ownUrl) {
                cropImageUrl = ownUrl
              } else {
                // 找连到 imageUrl 输入端口的上游节点
                const conn = connections.find((c) => c.targetNodeId === node.id && c.targetPort === 'imageUrl')
                if (conn) {
                  const srcLog = executionLogs.find((l) => l.nodeId === conn.sourceNodeId && l.status === 'success')
                  const srcOutput = srcLog?.output
                  // 上游输出可能是 imageUrl / images[0] / image
                  if (srcOutput?.imageUrl) cropImageUrl = String(srcOutput.imageUrl)
                  else if (Array.isArray(srcOutput?.images) && srcOutput.images[0]) cropImageUrl = String(srcOutput.images[0])
                  else if (srcOutput?.image) cropImageUrl = String(srcOutput.image)
                  else {
                    // 上游节点自身的输入图片（如带 image 输入端口的节点）
                    const srcNode = canvasNodes.find((n) => n.id === conn.sourceNodeId)
                    if (srcNode) {
                      const srcInput = srcNode.inputs
                      cropImageUrl = String(srcInput.image ?? srcInput.imageUrl ?? srcInput.imageA ?? '')
                    }
                  }
                }
              }
            }
            return (
            <CanvasNodeCard
              key={node.id}
              node={node}
              info={effectiveInfos.get(node.id)}
              selected={selectedNodeIds.includes(node.id)}
              output={nodeLog?.output}
              cropImageUrl={cropImageUrl}
              doodleImageUrl={node.type === 'face-doodle' ? cropImageUrl : undefined}
              statusColor={statusColors[nodeStatusMap(node.id)]}
              highlighted={highlightIds.includes(node.id)}
              onHeaderPointerDown={stableNodeHeaderPointerDown}
              onPortPointerDown={stablePortPointerDown}
              onPortPointerUp={stablePortPointerUp}
              onNodeMenu={stableOpenNodeMenu}
              onUpdateInput={updateNodeInput}
              onOpenWorkbench={node.type === 'face-doodle' ? setDoodleWorkbenchNodeId : setCropWorkbenchNodeId}
              dragSourceType={dragSourceType}
              modelOptions={modelOptions}
              onPreviewImage={handlePreviewImageWithCompare}
              onPreviewVideo={setPreviewVideo}
              running={running}
              onRun={() => runWorkflow(node.id)}
              refImages={(node.type === 'image-generate' || node.type === 'nine-grid-loop') ? refImagesFor(node.id) : []}
              onUploadFiles={(files) => handleNodeUploadFiles(node, files)}
              cardOpen={panelOpenNodeId === node.id}
              measuredHeight={nodeHeights.get(node.id)}
              onDeriveNode={handleDeriveNode}
            />
            )
          })}

        {/* Copilot 计划幽灵预览(虚线,批准前可见;审批后实体化) */}
        {ghostState && ghostState.nodes.length > 0 && (() => {
          let maxX = 80
          const startY = 60
          for (const n of canvasNodes) maxX = Math.max(maxX, n.x + nodeWidthFor(n.type))
          const gLayout = new Map<string, { x: number; y: number; h: number; nodeType: string; info?: NodeInfo }>()
          ghostState.nodes.forEach((gn, i) => {
            const info = nodeInfoMap.get(gn.nodeType)
            const h = estimateNodeHeight(info)
            gLayout.set(gn.id, { x: maxX + 48, y: startY + i * (h + 48), h, nodeType: gn.nodeType, info })
          })
          const ghostPos = (id: string, side: 'in' | 'out') => {
            const g = gLayout.get(id)
            if (g) return side === 'out' ? { x: g.x + nodeWidthFor(g.nodeType), y: g.y + 24 } : { x: g.x, y: g.y + 24 }
            const rn = canvasNodes.find((n) => n.id === id)
            return rn ? (side === 'out' ? { x: rn.x + nodeWidthFor(rn.type), y: rn.y + 24 } : { x: rn.x, y: rn.y + 24 }) : null
          }
          return (
            <>
              {ghostState.connections.length > 0 && (
                <svg className="absolute top-0 left-0" style={{ width: '20000px', height: '20000px', overflow: 'visible', pointerEvents: 'none' }}>
                  {ghostState.connections.map((gc, i) => {
                    const s = ghostPos(gc.sourceId, 'out'), t = ghostPos(gc.targetId, 'in')
                    if (!s || !t) return null
                    return <path key={i} d={getBezierPath(s.x, s.y, t.x, t.y)} fill="none" stroke="var(--warning-amber)" strokeWidth={2} strokeDasharray="6 4" opacity={0.8} />
                  })}
                </svg>
              )}
              {ghostState.nodes.map((gn) => {
                const g = gLayout.get(gn.id)
                if (!g) return null
                const catIcon = g.info ? categoryIcons[g.info.category] : undefined
                return (
                  <div key={gn.id} className="absolute rounded-lg border-2 border-dashed border-warning-amber bg-warning-amber/5 text-warning-deep flex items-center gap-1.5 px-3 text-xs font-medium" style={{ left: g.x, top: g.y, width: NODE_WIDTH, minHeight: g.h, opacity: 0.95 }}>
                    <span>{catIcon}</span>
                    <span>{g.info?.label || gn.nodeType}</span>
                    <span className="ml-auto text-[10px] text-warning-amber">计划中</span>
                  </div>
                )
              })}
            </>
          )
        })()}
        </div>{/* 闭合 world transform container */}

        {/* 低安全等级账号顶部警告 */}
        <SecurityBanner />

        {/* 连线状态图例(有执行日志时显示,置于工具栏正下方,不遮挡画布) */}
        {executionLogs.length > 0 && (
          <div className="absolute top-20 left-20 z-20 flex items-center gap-4 rounded-full bg-white/90 backdrop-blur border border-border px-4 py-1.5 shadow-sm">
            {([
              ['success', '成功'],
              ['running', '执行中'],
              ['error', '失败'],
              ['idle', '未执行'],
            ] as const).map(([s, label]) => (
              <span key={s} className="flex items-center gap-1.5 text-xs text-text-muted">
                <span className="inline-block w-4 h-0.5 rounded-full" style={{ backgroundColor: statusColors[s] }} />
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Empty state：从对话开始（Copilot 引导），而非空白焦虑 */}
        {canvasNodes.length === 0 && !dragOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <AnimatedLogo size={72} className="mb-5" />
            <Title level={4} className="mb-1 text-foreground">从一句话开始创作</Title>
            <Paragraph className="mb-6 text-text-secondary max-w-md text-center">
              描述你想做的内容，Copilot 会帮你搭好节点工作流。也可以从左侧拖拽节点手动搭建。
            </Paragraph>
            <div className="pointer-events-auto flex flex-wrap justify-center gap-2 max-w-xl">
              {EMPTY_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setCopilotExternalPrompt(p)}
                  className="rounded-full border border-accent/25 bg-white/80 px-4 py-2 text-xs text-text-muted shadow-sm backdrop-blur transition-all hover:border-accent hover:text-accent hover:shadow-md"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Toolbar：按「视图 / 编辑 / 工作流 / 运行 / 帮助」分组（三库入口放菜单条最前，点击收起/打开）。
        液态玻璃条：更小（py-1）/ 上移（top-3）/ 大 R 角（rounded-2xl）+ 玻璃描边高光 */}
        <div className="canvas-toolbar absolute top-3 left-[72px] flex flex-wrap items-center gap-1.5 bg-white/70 backdrop-blur-xl rounded-2xl shadow-[0_6px_20px_rgba(90,50,180,0.12),inset_0_1px_0_rgba(255,255,255,0.6)] border border-white/60 px-1.5 py-1 z-20 max-w-[calc(100%-2rem)] glass-hairline-wrap">
          {/* 顶部高光线 */}
          <span className="pointer-events-none absolute inset-x-3 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/80 to-transparent" />
          {/* 三库按钮：节点库 / 预设库 / 工具库 */}
          <div className="flex items-center gap-0.5 rounded-full border border-white/50 bg-gradient-to-b from-white/70 to-white/40 p-0.5 backdrop-blur-md">
            {[
              { mode: 'nodes' as const, icon: <AppstoreOutlined />, label: '节点库' },
              { mode: 'presets' as const, icon: <BookOutlined />, label: '提示词库' },
              { mode: 'tools' as const, icon: <ToolOutlined />, label: '工具箱' },
            ].map((it) => (
              <button
                key={it.mode}
                type="button"
                data-guide={it.mode === 'nodes' ? 'canvas-node-lib' : undefined}
                ref={(el) => { catalogAnchorRefs.current[it.mode] = el }}
                onClick={() => {
                  setCatalogMode(it.mode)
                  captureCatalogAnchor(it.mode)
                  setCatalogPinned((p) => (catalogMode === it.mode ? !p : true))
                }}
                onMouseEnter={() => {
                  setCatalogMode(it.mode)
                  captureCatalogAnchor(it.mode)
                  catalogHoverOpen()
                }}
                onMouseLeave={catalogHoverClose}
                className={`flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-all duration-150 ${
                  catalogMode === it.mode && (catalogPinned || catalogHover)
                    ? 'bg-gradient-to-br from-accent/15 to-accent/5 text-accent shadow-[0_1px_4px_rgba(125,80,224,0.25)]'
                    : 'text-text-secondary hover:bg-black/[0.04] hover:text-foreground'
                }`}
              >
                {it.icon}
                <span>{it.label}</span>
              </button>
            ))}
          </div>
          <span className="h-3 w-px bg-black/10 mx-0.5" />
          {/* 视图 */}
          <Button type="text" size="small" icon={<ZoomOutOutlined />} onClick={zoomOut} title="缩小" />
          <Text className="text-xs min-w-[48px] text-center">{Math.round(viewport.scale * 100)}%</Text>
          <Button type="text" size="small" icon={<ZoomInOutlined />} onClick={zoomIn} title="放大" />
          <Tooltip title="适应画布全貌 (快捷键: F)">
            <Button type="text" size="small" icon={<FullscreenOutlined />} onClick={fitView} title="适应画布全貌 (快捷键: F)" />
          </Tooltip>
          <Tooltip title="添加便签（记录灵感 / Prompt / 评审意见）">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => addStickyNote()} title="添加便签（记录灵感 / Prompt / 评审意见）" />
          </Tooltip>
          <span className="h-3 w-px bg-black/10 mx-0.5" />
          {/* 编辑：回退/前进（撤销/重做）+ 清空画布 */}
          <Tooltip title="撤销 (Ctrl+Z)">
            <Button type="text" size="small" icon={<UndoOutlined />} onClick={undo} disabled={undoStack.length === 0} title="撤销 (Ctrl+Z)" />
          </Tooltip>
          <Tooltip title="重做 (Ctrl+Shift+Z)">
            <Button type="text" size="small" icon={<RedoOutlined />} onClick={redo} disabled={redoStack.length === 0} title="重做 (Ctrl+Shift+Z)" />
          </Tooltip>
          <Popconfirm
            title="清空画布"
            description="将删除所有节点和连线，可用回退恢复"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={clearCanvas}
            disabled={canvasNodes.length === 0}
          >
            <Tooltip title="清空画布">
              <Button type="text" size="small" danger icon={<ClearOutlined />} disabled={canvasNodes.length === 0} title="清空画布" />
            </Tooltip>
          </Popconfirm>
          <Tooltip title="整理全部节点排布">
            <Button type="text" size="small" icon={<PartitionOutlined />} onClick={() => autoLayout(canvasNodes.map((n) => n.id), connections, { direction: 'LR' })} title="整理全部节点排布" />
          </Tooltip>
          <span className="h-3 w-px bg-black/10 mx-0.5" />
          {/* 缩略图：悬停预览 / 点击固定（保存/打开、官方导入已整合进「工作流库」下拉） */}
          <Button
            type="text"
            size="small"
            icon={<PictureOutlined />}
            onMouseEnter={() => setMinimapHover(true)}
            onMouseLeave={() => setMinimapHover(false)}
            onClick={() => setMinimapPinned((p) => !p)}
            className={`${minimapPinned ? 'text-accent' : ''}`}
            title="缩略图（悬停预览，点击固定）"
          />
          <Button type="text" size="small" icon={<ExportOutlined />} onClick={exportWorkflow} title="导出 JSON" />
          <Button type="text" size="small" icon={<ThunderboltFilled />} onClick={() => {
            if (canvasNodes.length === 0) { message.warning('画布为空，无法存为工具'); return }
            const covers: string[] = []
            executionLogs.forEach((log) => {
              if (log.status !== 'success' || !log.output) return
              if (typeof log.output.imageUrl === 'string' && log.output.imageUrl) covers.push(log.output.imageUrl)
              if (Array.isArray(log.output.images)) log.output.images.forEach((u) => { if (typeof u === 'string' && u && !covers.includes(u)) covers.push(u) })
            })
            setPublishCover(covers.length ? covers[covers.length - 1] : undefined)
            setPublishToolOpen(true)
          }} title="把画布工作流存为人人可用的工具">
            <span className="text-xs">存为工具</span>
          </Button>
          <span className="h-3 w-px bg-black/10 mx-0.5" />
          {/* 帮助 */}
          <Button type="text" size="small" icon={<QuestionCircleOutlined />} onClick={() => setNodeDocsOpen(true)} title="节点帮助">
            <span className="text-xs">帮助</span>
          </Button>
          {/* 运行/演示：最常用，突出显示在最右端（主色按钮 + 与其他功能隔开） */}
          <span className="h-4 w-px bg-border mx-1.5" />
          {running ? (
            <Button type="primary" size="small" danger icon={<StopOutlined />} onClick={stopWorkflow} className="!px-3">停止</Button>
          ) : (
            <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => runWorkflow()} className="!px-3">运行</Button>
          )}
          <Button size="small" icon={<ThunderboltOutlined />} onClick={runDemoSimulation} disabled={running} title="用素材模拟运行，不消耗积分" className="!px-2.5">
            <span className="text-xs">模拟</span>
          </Button>
        </div>

        {/* 存为工具向导（三步装配清单） */}
        <PublishToolWizard
          open={publishToolOpen}
          onCancel={() => setPublishToolOpen(false)}
          onSuccess={(slug) => {
            setPublishToolOpen(false)
            void router.push(`/tools/${slug}`)
          }}
          nodes={canvasNodes as unknown as Array<Record<string, unknown>>}
          connections={connections as unknown as Array<Record<string, unknown>>}
          coverUrl={publishCover}
          forkedFrom={remixToolId}
        />

        {/* 保存 / 打开工作流弹窗（抽为独立组件，见 components/canvas/WorkflowSaveModal） */}
        <WorkflowSaveModal
          open={workflowModalOpen}
          onClose={() => setWorkflowModalOpen(false)}
          name={workflowName}
          onNameChange={setWorkflowName}
          onSave={saveWorkflow}
          saving={savingWorkflow}
          workflows={workflows}
          onLoad={loadWorkflow}
          onRefresh={fetchWorkflows}
        />

        {/* Execution Panel：左侧竖向胶囊（靠下），点击向右展开面板，再点收回 */}
        {(running || executionLogs.length > 0 || executionError) && (
          logsCollapsed ? (
            <div
              className="absolute left-3 bottom-6 z-20 flex cursor-pointer flex-col items-center gap-2 rounded-full border border-border bg-white/90 px-1.5 py-4 shadow-sm backdrop-blur transition-shadow hover:shadow-md"
              onClick={() => setLogsCollapsed(false)}
              title="打开执行日志"
            >
              <MenuUnfoldOutlined className="text-sm text-accent" />
              <span className="text-xs text-text-muted" style={{ writingMode: 'vertical-rl', letterSpacing: '0.2em' }}>执行日志</span>
              {running && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
            </div>
          ) : (
          <div
            className="absolute bottom-6 left-16 bg-white/95 backdrop-blur rounded-lg shadow-sm border border-border z-20 flex flex-col"
            style={{
              width: 420,
              maxHeight: '50vh',
            }}
          >
            <div
              className="px-4 py-2 border-b border-border flex items-center justify-between select-none"
            >
              <Space size={8}>
                <Text strong className="text-sm">执行日志</Text>
                {running && <Text className="text-xs text-primary">运行中...</Text>}
              </Space>
              <Button type="text" size="small" icon={<MenuFoldOutlined />} onClick={(e) => { e.stopPropagation(); setLogsCollapsed(true) }} title="收起" />
            </div>
            {!logsCollapsed && (
              <div className="p-3 overflow-y-auto aigc-hub-scrollbar flex-1 space-y-2">
                {executionError && (
                  <div className="text-xs text-danger bg-danger/10 rounded px-3 py-2">
                    执行失败: {executionError}
                  </div>
                )}
                {executionLogs.map((log) => {
                  const node = canvasNodes.find((n) => n.id === log.nodeId)
                  return (
                    <div key={log.nodeId} className="text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span>{node?.label || log.nodeId}</span>
                        {log.status === 'running' && <span className="text-primary">运行中</span>}
                        {log.status === 'success' && <span className="text-success">完成</span>}
                        {log.status === 'error' && <span className="text-danger">失败</span>}
                      </div>
                      {log.status === 'success' && log.output && (
                        <div className="bg-surface rounded p-2 text-[10px] text-text-muted overflow-x-auto">
                          {log.output.videoUrl ? (
                            // 视频输出：显示播放器
                            <div>
                              { }
                              <video src={String(log.output.videoUrl)} controls className="max-w-full rounded mb-2" style={{ maxWidth: '100%', maxHeight: 192 }} />
                              <div className="text-text-secondary break-all">{String(log.output.videoUrl)}</div>
                            </div>
                          ) : log.output.imageUrl ? (
                            // 图片输出：真正显示图片预览
                            <div>
                              <Image src={String(log.output.imageUrl)} alt="预览" className="max-w-full rounded mb-2" style={{ maxWidth: '100%', maxHeight: 192 }} fallback="/placeholder.png" />
                              <div className="text-text-secondary break-all">{String(log.output.imageUrl)}</div>
                            </div>
                          ) : log.output.images && Array.isArray(log.output.images) ? (
                            // 图片列表（可点击预览大图）
                            <Image.PreviewGroup>
                              <div className="flex flex-wrap gap-2">
                                {log.output.images.map((img: string, i: number) => (
                                  <Image key={i} src={String(img)} alt={`预览${i}`} width={120} height={96} className="rounded object-cover" />
                                ))}
                              </div>
                            </Image.PreviewGroup>
                          ) : log.output.text !== undefined ? (
                            // 文本输出：可读纯文本（非 JSON）
                            <pre className="whitespace-pre-wrap break-all m-0">{String(log.output.text)}</pre>
                          ) : log.output.output !== undefined ? (
                            <pre className="whitespace-pre-wrap break-all m-0">{String(log.output.output)}</pre>
                          ) : (
                            <pre className="whitespace-pre-wrap break-all m-0">{JSON.stringify(log.output, null, 2)}</pre>
                          )}
                        </div>
                      )}
                      {log.error && <div className="text-danger text-[10px]">{log.error}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          )
        )}

        {/* Minimap：工具栏按钮控制（悬停预览/点击固定），显示在工具栏右端正下方（与左侧库下拉错开） */}
        {(minimapPinned || minimapHover) && (
          <div className="absolute right-2 top-16 z-30 w-[164px] bg-white/90 backdrop-blur rounded-lg border border-border shadow-sm p-1">
            <Minimap
              nodes={canvasNodes}
              viewport={viewport}
              containerSize={{
                width: canvasBox.width,
                height: canvasBox.height,
              }}
              onViewportChange={setViewport}
            />
          </div>
        )}

        {/* 节点帮助 Modal */}
        <NodeDocsModal open={nodeDocsOpen} onClose={() => setNodeDocsOpen(false)} />

        {/* 图片/视频放大预览（支持智能 Before/After 卷帘对比） */}
        <MediaPreviewModals
          image={previewImage}
          compareImage={previewCompareImage}
          video={previewVideo}
          onCloseImage={() => { setPreviewImage(null); setPreviewCompareImage(null) }}
          onCloseVideo={() => setPreviewVideo(null)}
        />

        {/* 节点右键/长按菜单(触屏长按 / 桌面右键) */}
        {nodeMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => { if (Date.now() - nodeMenuSuppressCloseRef.current < 450) return; setNodeMenu(null) }} onContextMenu={(e) => { e.preventDefault(); if (Date.now() - nodeMenuSuppressCloseRef.current < 450) return; setNodeMenu(null) }} />
            <div data-node-menu className="fixed z-50" style={{ left: nodeMenu.x, top: nodeMenu.y }}>
              <Menu
                items={[
                  { key: 'copy', icon: <CopyOutlined />, label: '复制' },
                  { key: 'add-note', icon: <EditOutlined />, label: '添加便签' },
                  { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
                ]}
                onClick={({ key }) => {
                  if (key === 'copy') copySelected()
                  if (key === 'add-note') {
                    const rect = canvasRef.current?.getBoundingClientRect()
                    if (rect) {
                      const v = viewportRef.current
                      const wx = (nodeMenu.x - rect.left - v.x) / v.scale
                      const wy = (nodeMenu.y - rect.top - v.y) / v.scale
                      addStickyNote(wx, wy)
                    }
                  }
                  if (key === 'delete') deleteSelected()
                  setNodeMenu(null)
                }}
                style={{ borderRadius: 8, border: '1px solid var(--border-color)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
              />
            </div>
          </>
        )}

        {/* Copilot 助手 + 工具面板（一体化，手动切换 助手/工具 模式） */}
        {(() => {
          const toolOutputs: Record<string, Record<string, unknown>> = {}
          if (toolPanel) {
            for (const nid of toolPanel.nodeIds) {
              const log = executionLogs.find((l) => l.nodeId === nid && l.status === 'success')
              if (log?.output) toolOutputs[nid] = log.output as Record<string, unknown>
            }
          }
          return (
            <>
            {/* 首次进入画布：引导先选 Copilot 的「大脑模型」（只弹一次） */}
            <FirstUseGuide storageKey="copilot" steps={[...GUIDE_STEPS.copilot]} />
            <CopilotPanel
              ops={canvasOps}
              modelOptions={modelOptions}
              containerRef={canvasRef}
              externalPrompt={copilotExternalPrompt}
              autoRun={copilotAutoRun}
              toolState={toolPanel}
              toolModelOptions={modelOptions}
              toolModelsLoading={modelsLoading}
              toolOutputs={toolOutputs}
              onToolRun={toolRun}
              onToolClose={() => setToolPanel(null)}
            />
            </>
          )
        })()}

        {/* 双击画布空白 → 就近选节点（quickPicker：复用 CatalogPanel 两级 hover 级联，点选即原地落点） */}
        {quickPicker && (
          <>
            {/* 点击面板外空白关闭 */}
            <div
              className="absolute inset-0 z-40"
              data-canvas-background
              onClick={closeQuickPicker}
            />
            <CatalogPanel
              mode="nodes"
              open
              pinned={false}
              anchorRect={{ left: quickPicker.x, bottom: quickPicker.y }}
              groupedNodes={groupedNodes}
              onClose={closeQuickPicker}
              onSetPinned={() => {}}
              autoDismiss={false}
              showPin={false}
              onDragNodeStart={handleCatalogDragStart}
              onTapNode={(node) => quickPickNode(node)}
            />
          </>
        )}

        {/* 裁切工作台 Modal */}
        {cropWorkbenchNodeId && (() => {
          const cropNode = canvasNodes.find((n) => n.id === cropWorkbenchNodeId)
          if (!cropNode) return null
          // 解析裁切节点的图片源（复用 cropImageUrl 逻辑）
          const ownUrl = String(cropNode.inputs.imageUrl ?? '')
          let wbImageUrl = ownUrl
          if (!wbImageUrl) {
            const conn = connections.find((c) => c.targetNodeId === cropNode.id && c.targetPort === 'imageUrl')
            if (conn) {
              const srcLog = executionLogs.find((l) => l.nodeId === conn.sourceNodeId && l.status === 'success')
              const srcOutput = srcLog?.output
              if (srcOutput?.imageUrl) wbImageUrl = String(srcOutput.imageUrl)
              else if (Array.isArray(srcOutput?.images) && srcOutput.images[0]) wbImageUrl = String(srcOutput.images[0])
              else if (srcOutput?.image) wbImageUrl = String(srcOutput.image)
              else {
                const srcNode = canvasNodes.find((n) => n.id === conn.sourceNodeId)
                if (srcNode) wbImageUrl = String(srcNode.inputs.image ?? srcNode.inputs.imageUrl ?? srcNode.inputs.imageA ?? '')
              }
            }
          }
          return (
            <CropWorkbench
              open={!!cropWorkbenchNodeId}
              imageUrl={wbImageUrl}
              initialMode={(cropNode.inputs.mode as 'single' | 'grid4' | 'grid9') || 'single'}
              initialRegions={(cropNode.inputs.cropRegions as { x: number; y: number; width: number; height: number }[]) || []}
              onConfirm={(mode, regions) => {
                updateNodeInput(cropNode.id, 'mode', mode)
                updateNodeInput(cropNode.id, 'cropRegions', regions)
                setCropWorkbenchNodeId(null)
              }}
              onCancel={() => setCropWorkbenchNodeId(null)}
            />
          )
        })()}

        {/* 人脸涂鸦工作台 Modal */}
        {doodleWorkbenchNodeId && (() => {
          const doodleNode = canvasNodes.find((n) => n.id === doodleWorkbenchNodeId)
          if (!doodleNode) return null
          // 解析涂鸦节点的图片源（与裁切同法：自身值 → 上游运行结果 → 上游节点输入值）
          const ownUrl = String(doodleNode.inputs.imageUrl ?? '')
          let wbImageUrl = ownUrl
          if (!wbImageUrl) {
            const conn = connections.find((c) => c.targetNodeId === doodleNode.id && c.targetPort === 'imageUrl')
            if (conn) {
              const srcLog = executionLogs.find((l) => l.nodeId === conn.sourceNodeId && l.status === 'success')
              const srcOutput = srcLog?.output
              if (srcOutput?.imageUrl) wbImageUrl = String(srcOutput.imageUrl)
              else if (Array.isArray(srcOutput?.images) && srcOutput.images[0]) wbImageUrl = String(srcOutput.images[0])
              else if (srcOutput?.image) wbImageUrl = String(srcOutput.image)
              else {
                const srcNode = canvasNodes.find((n) => n.id === conn.sourceNodeId)
                if (srcNode) wbImageUrl = String(srcNode.inputs.image ?? srcNode.inputs.imageUrl ?? srcNode.inputs.imageA ?? '')
              }
            }
          }
          return (
            <FaceDoodleWorkbench
              open={!!doodleWorkbenchNodeId}
              imageUrl={wbImageUrl}
              initialFaces={(doodleNode.inputs.faces as { x: number; y: number; w: number; h: number }[]) || []}
              initialParams={{
                density: Number(doodleNode.inputs.density ?? 42),
                strokeWidth: Number(doodleNode.inputs.strokeWidth ?? 2.2),
                spike: Number(doodleNode.inputs.spike ?? 1.25),
                coverage: Number(doodleNode.inputs.coverage ?? 1.1),
                multiView: doodleNode.inputs.multiView !== false,
                threshold: Number(doodleNode.inputs.threshold ?? 0.18),
                autoFallback: doodleNode.inputs.autoFallback !== false,
              }}
              onParamsChange={(patch) => {
                // 工作台与节点参数条共享同一份 inputs：改任一侧立即同步，
                // 不用等「确认出图」才写回，也不用重开工作台才能看到参数条变化。
                for (const [k, v] of Object.entries(patch)) {
                  if (v !== undefined) updateNodeInput(doodleNode.id, k, v)
                }
              }}
              onConfirm={({ imageUrl, faces }) => {
                // 涂鸦成图写回 imageUrl（执行器把它规范化为持久输出），
                // faces 一并写回供下次打开工作台恢复编辑现场
                updateNodeInput(doodleNode.id, 'imageUrl', imageUrl)
                updateNodeInput(doodleNode.id, 'faces', faces)
                setDoodleWorkbenchNodeId(null)
              }}
              onCancel={() => setDoodleWorkbenchNodeId(null)}
            />
          )
        })()}

        {/* Right: Properties panel — 节点属性 or 连线属性 */}
        {selectedConnectionId && (() => {
          const conn = connections.find((c) => c.id === selectedConnectionId)
          if (!conn) return null
          const srcNode = canvasNodes.find((n) => n.id === conn.sourceNodeId)
          const srcInfo = srcNode ? nodeInfoMap.get(srcNode.type) : undefined
          const srcOutput = srcInfo?.outputs?.[conn.sourcePort]
          const isArrayOutput = srcOutput?.type === 'array'
          return (
            <div className="absolute bottom-3 left-3 right-3 max-h-[35vh] overflow-y-auto aigc-hub-scrollbar bg-white/95 backdrop-blur rounded-lg shadow-sm border border-border p-4 z-20 md:top-4 md:right-4 md:bottom-auto md:left-auto md:w-72 md:max-h-[calc(100%-32px)]">
              <div className="flex items-center justify-between mb-3">
                <Text strong>连线属性</Text>
                <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => clearConnection()} title="关闭连线属性" />
              </div>
              <Paragraph className="text-xs text-text-secondary mb-3">
                {srcNode?.label || conn.sourceNodeId} ({conn.sourcePort} → {conn.targetPort})
              </Paragraph>
              {isArrayOutput ? (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-text-secondary">整传全部数组</span>
                    <Switch
                      size="small"
                      checked={conn.index === undefined}
                      onChange={(checked) =>
                        setConnections((prev) => prev.map((c) => (c.id === conn.id ? { ...c, index: checked ? undefined : 0 } : c)))
                      }
                    />
                  </div>
                  {conn.index !== undefined && (
                    <>
                      <label className="text-xs text-text-secondary block mb-1">数组索引(取第 N 个元素)</label>
                      <InputNumber
                        min={0}
                        size="small"
                        className="w-full"
                        value={conn.index}
                        onChange={(v) => setConnections((prev) => prev.map((c) => (c.id === conn.id ? { ...c, index: v ?? 0 } : c)))}
                        placeholder="0"
                      />
                      <Paragraph className="text-[10px] text-text-disabled mt-1">设为 0 取第 1 张,1 取第 2 张,以此类推</Paragraph>
                    </>
                  )}
                </div>
              ) : (
                <Paragraph className="text-xs text-text-disabled">上游输出非数组,无需设索引</Paragraph>
              )}
              <Button type="link" size="small" danger className="mt-2 px-0" onClick={() => {
                setConnections((prev) => prev.filter((c) => c.id !== conn.id))
                clearConnection()
              }}>删除此连线</Button>
            </div>
          )
        })()}
        {/* 浮动参数层已内联在节点卡身（node-bodies），此处旧面板只服务表单类节点 */}
        {panelNode && selectedInfo && !selectedConnectionId && !hasInlineBody(panelNode.type) && (() => {
          const isImgGen = false // 旧图像生成面板已由浮动参数层取代
          // 面板统一停靠节点正下方（ResizeObserver 跟随增高/平移），不再浮在节点两侧
          const pos = imgGenPanelPos ?? {
            left: Math.min(panelNode.x * viewport.scale + viewport.x, canvasBox.width ? canvasBox.width - (isImgGen ? 508 : 308) : 0),
            top: panelNode.y * viewport.scale + viewport.y + 220,
          }
          const updateInput = (key: string, v: unknown) =>
            setCanvasNodes((prev) => prev.map((n) => (n.id === panelNode.id ? { ...n, inputs: { ...n.inputs, [key]: v } } : n)))
          return (
          <div
            className={`canvas-panel-in absolute z-20 overflow-y-auto aigc-hub-scrollbar bg-white/70 backdrop-blur-md rounded-[10px] shadow-sm border border-border/70 p-3.5 origin-top-left ${
              isImgGen ? 'w-[400px]' : 'w-[260px]'
            }`}
            style={{ ...pos, transform: `scale(${viewport.scale})`, maxHeight: `${70 / viewport.scale}vh` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <Text strong>{panelNode.label}</Text>
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => { setSelectedNodeId(null); setPanelOpenNodeId(null) }} title="关闭节点面板" />
            </div>
            {!isImgGen && <Paragraph className="text-xs text-text-secondary mb-3">{selectedInfo.description}</Paragraph>}

            {panelNode.type === 'json-prompt-batch' && (
              <div className="mb-3 p-2 rounded border border-surface-pressed bg-surface">
                <Text className="text-xs text-text-muted block mb-2">
                  已解析 <Text strong>{getBatchCount(panelNode.id) || 0}</Text> 套语块
                  <span className="text-text-disabled">（先运行工作流或填入 JSON 后可展开）</span>
                </Text>
                {/* 扇出方式：决定由「后端克隆」还是「作者静态排布」来承接 N 套语块。
                    默认 expand 保持旧行为；静态排布的工作流必须选 index，否则会被多克隆 N-1 份。 */}
                <Text className="text-xs text-text-muted block mb-1">扇出方式</Text>
                <Segmented
                  size="small"
                  block
                  className="mb-1"
                  value={String(panelNode.inputs?.outputMode ?? 'expand')}
                  onChange={(v) => updateNodeInput(panelNode.id, 'outputMode', v)}
                  options={[
                    { value: 'expand', label: '自动展开' },
                    { value: 'index', label: '按连线序号' },
                  ]}
                />
                <Text className="text-[11px] text-text-disabled block mb-2 leading-relaxed">
                  {String(panelNode.inputs?.outputMode ?? 'expand') === 'index'
                    ? '下游已是排布好的多个节点，各自按连线序号取第 i 套语块，不再克隆。'
                    : '把下游节点自动克隆 N 份，每份取一套语块。'}
                </Text>
                <Button type="primary" size="small" block icon={<PartitionOutlined />} onClick={() => expandBatchNode(panelNode.id)}>
                  批量展开 / 重新同步
                </Button>
              </div>
            )}

            {isImgGen ? (
              <>
                {/* 参考图条：45px 缩略图（显示连线顺序，第 N 张参考图；提示词里用「第一张图/第二张图」指代） */}
                <div className="mb-3">
                  {selectedRefImages.length > 0 ? (
                    <div className="flex gap-2 overflow-x-auto py-0.5 aigc-hub-scrollbar">
                      {selectedRefImages.map((src, i) => (
                        <RefThumb
                          key={i}
                          src={src}
                          index={i}
                        />
                      ))}
                    </div>
                  ) : (
                    <Paragraph className="text-xs text-text-disabled">连接图片节点到「参考图片」端口后，这里按顺序显示参考图；提示词里用「第一张图/第二张图」等描述指代</Paragraph>
                  )}
                </div>
                {/* 提示词编辑器：高 160px 起步，可拖拽调高 */}
                <PromptEditor
                  value={String(panelNode.inputs.prompt || '')}
                  onChange={(v) => updateInput('prompt', v)}
                  references={selectedRefImages.map((src) => ({ src }))}
                  placeholder="描述画面，用「第一张图/第二张图」指代已连接的参考图…"
                />
                {/* 参数行：负向提示词折叠收纳 */}
                <details className="mt-3 group">
                  <summary className="text-xs text-text-secondary cursor-pointer select-none hover:text-accent">负向提示词（不希望出现的元素）</summary>
                  <div className="mt-2">
                    {renderInputField(panelNode, 'negativePrompt', selectedInfo.inputs.negativePrompt, setCanvasNodes, modelOptions, modelsLoading)}
                  </div>
                </details>
                {/* 操作行：模型/尺寸靠左，运行按钮靠右（对齐 Toonflow 底部操作栏） */}
                <div className="mt-3 pt-3 border-t border-border flex items-end gap-2">
                  <div className="flex-1 min-w-0">
                    <label className="text-[10px] text-text-disabled block mb-1">模型</label>
                    {renderInputField(panelNode, 'model', selectedInfo.inputs.model, setCanvasNodes, modelOptions, modelsLoading)}
                  </div>
                  <Button type="primary" size="middle" loading={running} onClick={() => runWorkflow()} className="!rounded-lg !px-4 shrink-0">
                    生成
                  </Button>
                </div>
                {/* 尺寸：模型配了预设时显示比例+档位联动下拉（占整行）；未配置时回退宽/高数字输入 */}
                {(() => {
                  const modelId = panelNode.inputs.model as string | undefined
                  const model = modelOptions.find((m) => m.id === modelId)
                  const imageCap = getImageCapabilities(model)
                  if (!imageCap.declared || imageCap.sizes.length === 0) {
                    return (
                      <div className="mt-2 flex items-end gap-2">
                        <div className="w-[72px]">
                          <label className="text-[10px] text-text-disabled block mb-1">宽</label>
                          {renderInputField(panelNode, 'width', selectedInfo.inputs.width, setCanvasNodes, modelOptions, modelsLoading)}
                        </div>
                        <div className="w-[72px]">
                          <label className="text-[10px] text-text-disabled block mb-1">高</label>
                          {renderInputField(panelNode, 'height', selectedInfo.inputs.height, setCanvasNodes, modelOptions, modelsLoading)}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div className="mt-2">
                      <label className="text-[10px] text-text-disabled block mb-1">尺寸（比例 · 档位）</label>
                      {renderInputField(panelNode, 'width', selectedInfo.inputs.width, setCanvasNodes, modelOptions, modelsLoading)}
                    </div>
                  )
                })()}
              </>
            ) : (
              <div className="space-y-3">
                {Object.entries(selectedInfo.inputs).map(([key, port]) => (
                  <div key={key}>
                    <label className="text-xs text-text-secondary block mb-1">
                      {port.label} {port.required && <span className="text-danger">*</span>}
                    </label>
                    {renderInputField(panelNode, key, port, setCanvasNodes, modelOptions, modelsLoading)}
                  </div>
                ))}
              </div>
            )}
          </div>
          )
        })()}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

// React.memo：上传大图等高频 setState 时跳过无关节点卡片重渲染（props 已全部引用稳定化）
