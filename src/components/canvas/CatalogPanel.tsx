'use client'

// 三库（节点库 / 预设库 / 工具库）两级 hover 级联面板：
// 1. 顶部菜单条按钮 hover → 下方弹出"分类列表"面板（200px 宽）
// 2. hover 分类 → 紧贴右侧弹出"详情列表"面板（320px 宽，节点/工具/预设项）
//
// 同时复用于「双击画布 → 就近选节点」（quickPicker 模式，autoDismiss=false + showPin=false）：
// 面板从双击位置弹出，hover 分类出详情，点选节点即落点关闭。
//
// 用 createPortal 渲染到 document.body，避免被画布 transform: scale 影响位置。
// 通过 anchorRect（按钮/双击点的屏幕坐标）计算面板绝对位置。
// 鼠标在两面板之间 + 按钮区域之间构成"连续 hover 区域"，避免路径上触发关闭。
// 点击按钮切换 pinned 状态（pinned 时不随 hover 自动关闭，右上有关闭按钮）。

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Input, Typography, Button, Tag, Tooltip } from 'antd'
import { SearchOutlined, CloseOutlined, ToolOutlined, RobotOutlined, PartitionOutlined, FileTextOutlined, ThunderboltOutlined, PictureOutlined, VideoCameraOutlined, SoundOutlined, BranchesOutlined, DatabaseOutlined, ImportOutlined } from '@ant-design/icons'
import { categoryColors, categoryLabels } from '@/lib/canvas-utils'
import type { NodeInfo } from '@/lib/canvas-utils'
import type { WorkflowTool } from '@/app/(app)/canvas/tool-types'
import { toAssetProxyUrl, toProxyUrl } from '@/lib/media-url'
import { apiFetch } from '@/lib/api-client'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'

const { Text } = Typography

type CatalogMode = 'nodes' | 'presets' | 'tools'

// 节点分类图标（与 page.tsx 保持一致：父分类 → 图标）
const categoryIcons: Record<string, React.ReactNode> = {
  llm: <ThunderboltOutlined />,
  image: <PictureOutlined />,
  video: <VideoCameraOutlined />,
  audio: <SoundOutlined />,
  logic: <BranchesOutlined />,
  data: <DatabaseOutlined />,
  io: <ImportOutlined />,
  custom: <ImportOutlined />,
}

// 预设库
type PresetTemplate = {
  id: string
  name: string
  description: string
  category: 'node' | 'workflow' | 'prompt'
  nodes?: { type: string; systemPrompt?: string }[]
  connections?: { source: number; sourcePort: string; target: number; targetPort: string }[]
  prompts?: string[]
}

export interface CatalogPanelProps {
  mode: CatalogMode
  open: boolean
  pinned: boolean
  // 锚点：按钮的 getBoundingClientRect()（菜单模式）或双击点的屏幕坐标 {left,bottom}（quickPicker 模式）
  anchorRect: Pick<DOMRect, 'left' | 'bottom'> | null
  // 面板区（分类/详情两面板）hover 进出回调：父组件用它保住自身 catalogOpen 状态，
  // 否则菜单按钮 onMouseLeave 的关闭定时器会在鼠标移到面板上时误关整块。
  onAreaEnter?: () => void
  onAreaLeave?: () => void
  // quickPicker 等"点选后即关"场景：鼠标移出面板不自动收起（只靠点击外部/选中节点关闭）
  autoDismiss?: boolean
  // 是否显示"固定/解锁"按钮（quickPicker 无固定语义，隐藏）
  showPin?: boolean
  // 节点库
  groupedNodes?: Record<string, NodeInfo[]>
  onClose: () => void
  onSetPinned: (pinned: boolean) => void
  // 工具库
  toolTemplates?: WorkflowTool[]
  onUseTool?: (t: WorkflowTool) => void
  /** 线上工具箱已上架工具（官方优先），点击导入画布调试 */
  remoteTools?: Array<{ id: string; name: string; description: string | null; category: string | null; isOfficial: boolean }>
  onImportRemoteTool?: (id: string, name: string) => void
  // 预设库
  presetTemplates?: PresetTemplate[]
  onImportPreset?: (t: PresetTemplate) => void
  /** 提示词库（原预设库 prompt 分类）：线上公开提示词，两类展示 */
  promptLibItems?: PromptLibItem[]
  promptLibLoading?: boolean
  // 拖拽节点用
  onDragNodeStart?: (e: React.DragEvent, node: NodeInfo) => void
  onTapNode?: (node: NodeInfo) => void
}

// 该库的分类列表
function catsForMode(mode: CatalogMode, nodeCats: string[], toolTemplates: WorkflowTool[]): string[] {
  if (mode === 'presets') return ['creative', 'functional']
  if (mode === 'tools') {
    const set = new Set<string>()
    toolTemplates.forEach((t) => set.add(t.category || '其他'))
    return [...set]
  }
  return nodeCats
}

function catLabel(mode: CatalogMode, cat: string): string {
  if (mode === 'presets') return cat === 'creative' ? '创作型成品' : '功能型模板'
  if (mode === 'tools') return cat
  return categoryLabels[cat] || cat
}

function catIcon(mode: CatalogMode, cat: string) {
  if (mode === 'presets') {
    return cat === 'creative' ? <PictureOutlined className="text-accent" /> : <FileTextOutlined className="text-accent" />
  }
  if (mode === 'tools') return <ToolOutlined className="text-accent" />
  return <span style={{ color: categoryColors[cat] || '#8C8C8C' }}>{categoryIcons[cat]}</span>
}

function catColor(mode: CatalogMode, cat: string): string {
  if (mode !== 'nodes') return 'var(--accent)'
  return categoryColors[cat] || '#8C8C8C'
}

export function CatalogPanel({
  mode,
  open,
  pinned,
  anchorRect,
  onAreaEnter: parentEnter,
  onAreaLeave: parentLeave,
  autoDismiss = true,
  showPin = true,
  groupedNodes = {},
  onClose,
  onSetPinned,
  toolTemplates = [],
  onUseTool,
  remoteTools = [],
  onImportRemoteTool,
  presetTemplates = [],
  onImportPreset,
  promptLibItems = [],
  promptLibLoading = false,
  onDragNodeStart,
  onTapNode,
}: CatalogPanelProps) {
  const [hoverCat, setHoverCat] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // 200ms 防抖：hover 切分类时用 setTimeout 保留面板开
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detailRef = useRef<HTMLDivElement | null>(null)
  const categoryRef = useRef<HTMLDivElement | null>(null)
  // hover 分类行的屏幕 Y，详情面板与之对齐（鼠标放到哪个分类，详情面板就从那行右侧弹出）
  const [rowTop, setRowTop] = useState<number | null>(null)

  // 阻止鼠标在两面板间隙时关闭：hover 进面板就清掉关闭定时器
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  const scheduleClose = useCallback(() => {
    if (!autoDismiss || pinned) return
    cancelClose()
    closeTimer.current = setTimeout(() => {
      onClose()
    }, 200)
  }, [autoDismiss, pinned, onClose, cancelClose])

  // 关闭定时器 + hover 离开时清理
  useEffect(() => {
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current) }
  }, [])

  // hover 离开整个库（按钮 + 两面板）才关：同时通知父组件（避免按钮 onMouseLeave 误关），并走内部 200ms 防抖
  const onAreaEnter = useCallback(() => { cancelClose(); parentEnter?.() }, [cancelClose, parentEnter])
  const onAreaLeave = useCallback(() => { if (autoDismiss) scheduleClose(); parentLeave?.() }, [autoDismiss, scheduleClose, parentLeave])

  // 分类面板位置：锚点下方左对齐；quickPicker 模式锚点即双击点（width/height≈0），往下弹。
  // 统一做视口边界保护，防止双击靠近右/下边缘时面板溢出屏幕。
  const CAT_W = 176
  // 提示词库创作型瀑布流需要更宽的详情面板（2 列图才够大）
  const DETAIL_W = mode === 'presets' ? 360 : 300
  const PAD = 8
  // SSR 阶段没有 window：视口尺寸取 0 时直接退回 PAD，避免 prerender 崩溃（客户端首帧 layout effect 会修正）
  const vw = typeof window === 'undefined' ? 0 : window.innerWidth
  const vh = typeof window === 'undefined' ? 0 : window.innerHeight
  const clampX = (left: number, w: number) => (vw <= 0 ? PAD : Math.max(PAD, Math.min(left, vw - w - PAD)))
  const clampY = (top: number, maxH: number) => (vh <= 0 ? PAD : Math.max(PAD, Math.min(top, vh - maxH - PAD)))
  const catLeft = anchorRect ? clampX(anchorRect.left, CAT_W) : PAD
  const catTop = anchorRect ? clampY(anchorRect.bottom + 6, 460) : PAD
  // 详情面板位置：紧贴分类面板右边缘；top 对齐 hover 分类行（未 hover 时退到分类面板顶部）。
  // 视口保护用详情面板自身实测高度（上一帧 offsetHeight），不能写死 420——否则双击/拖线在
  // 画布下方弹出时，靠下的分类行会被整体 clamp 回面板顶部，看起来像「不跟随」。
  // 详情面板不与分类面板重叠：原来用 `+ CAT_W - 4`（向左压住 4px），
  // 两面板 zIndex 都是 60，重叠区命中详情面板 → 点分类右侧的计数徽章会失效。
  // 这里留 2px 视觉贴边（rounded 边框内已有留白），并给详情面板更高 z-index 兜底。
  const detailLeft = clampX(catLeft + CAT_W + 2, DETAIL_W)
  // 详情面板位置在 layout effect 里按实测高度重算（渲染期读 ref 会触发 react-hooks/refs）
  const [detailTop, setDetailTop] = useState(() => (rowTop != null ? clampY(rowTop - 2, 420) : catTop))
  useLayoutEffect(() => {
    if (!open) return
    const detailH = detailRef.current?.offsetHeight || 420
    setDetailTop(rowTop != null ? clampY(rowTop - 2, detailH) : catTop)
  }, [rowTop, catTop, mode, open])

  if (!open || !anchorRect) return null

  const nodeCats = Object.keys(groupedNodes)
  const toolCats: string[] = mode === 'tools'
    ? [...new Set([...toolTemplates, ...remoteTools].map((t) => t.category || '其他'))]
    : []
  const categories = mode === 'tools' ? toolCats : catsForMode(mode, nodeCats, toolTemplates)
  // 默认 hover/选中第一个分类
  const activeCat = hoverCat && categories.includes(hoverCat) ? hoverCat : categories[0] || null
  const modeIcon = mode === 'presets' ? <RobotOutlined className="text-accent" /> : mode === 'tools' ? <ToolOutlined className="text-accent" /> : <ThunderboltOutlined className="text-accent" />

  return createPortal(
    <>
      <style>{`
        @keyframes catalog-panel-in { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes catalog-detail-in { from { opacity: 0; transform: translateX(8px) } to { opacity: 1; transform: translateX(0) } }
      `}</style>

      {/* 分类面板（第一级） */}
      <div
        ref={categoryRef}
        onMouseEnter={onAreaEnter}
        onMouseLeave={onAreaLeave}
        style={{ position: 'fixed', left: catLeft, top: catTop, width: CAT_W, zIndex: 60, animation: 'catalog-panel-in .16s ease-out' }}
        className="glass-panel rounded-xl overflow-hidden backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/50 bg-gradient-to-r from-accent/8 via-white/30 to-transparent">
          <span className="grid place-items-center w-5 h-5 rounded-md bg-accent/10">{modeIcon}</span>
          <Text className="flex-1 text-[11px] font-semibold text-text-secondary">
            {mode === 'presets' ? '提示词库' : mode === 'tools' ? '工具库' : '节点库'}
          </Text>
          <div className="flex items-center gap-1.5">
            {pinned && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">已固定</span>}
            {showPin && (
              <button
                type="button"
                onClick={() => onSetPinned(!pinned)}
                className="text-[10px] text-text-secondary hover:text-foreground grid place-items-center w-5 h-5 rounded hover:bg-black/5"
                title={pinned ? '取消固定' : '固定打开'}
              >
                {pinned ? '解锁' : '📌'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="grid place-items-center w-5 h-5 rounded text-text-secondary hover:text-foreground hover:bg-black/5"
              title="关闭"
            >
              <CloseOutlined style={{ fontSize: 10 }} />
            </button>
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto aigc-hub-scrollbar py-1">
          {categories.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-text-disabled">暂无分类</div>
          ) : categories.map((cat) => {
            const isActive = activeCat === cat
            const cColor = catColor(mode, cat)
            return (
              <button
                key={cat}
                type="button"
                onMouseEnter={(e) => { cancelClose(); setHoverCat(cat); setRowTop((e.currentTarget as HTMLButtonElement).getBoundingClientRect().top) }}
                onClick={() => setHoverCat(cat)}
                className={`relative flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                  isActive ? 'bg-gradient-to-r from-accent/12 to-transparent font-medium' : 'text-text-secondary hover:bg-accent/5'
                }`}
              >
                {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: cColor }} />}
                <span className="w-4 flex justify-center" style={isActive ? { color: cColor } : undefined}>{catIcon(mode, cat)}</span>
                <span className={`flex-1 truncate ${isActive ? 'text-accent' : ''}`}>{catLabel(mode, cat)}</span>
                {mode === 'nodes' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/4 text-text-disabled">{(groupedNodes[cat] || []).length}</span>
                )}
                {mode === 'tools' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/4 text-text-disabled">
                    {toolTemplates.filter((t) => (t.category || '其他') === cat).length + remoteTools.filter((t) => (t.category || '其他') === cat).length}
                  </span>
                )}
                {mode === 'presets' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/4 text-text-disabled">
                    {promptLibItems.filter((t) => t.kind === cat).length}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 详情面板（第二级）：hover 分类时弹出，pinned 始终显示；
          autoDismiss=false 的 quickPicker 模式（双击/拖线悬空）也要默认展开首个分类，
          否则面板打开后只有分类列表、必须再 hover 一次才出详情，与菜单入口品质不一致 */}
      {(pinned || hoverCat || !autoDismiss) && activeCat && (
        <div
          ref={detailRef}
          onMouseEnter={onAreaEnter}
          onMouseLeave={onAreaLeave}
          style={{ position: 'fixed', left: detailLeft, top: detailTop, width: DETAIL_W, zIndex: 61, animation: 'catalog-detail-in .18s ease-out' }}
          className="glass-panel rounded-xl overflow-hidden backdrop-blur-xl"
        >
          {mode === 'nodes' && (
            <NodesDetail category={activeCat} groupedNodes={groupedNodes} search={search} setSearch={setSearch} onDragNodeStart={onDragNodeStart} onTapNode={onTapNode} />
          )}
          {mode === 'presets' && (
            <PromptLibDetail kind={activeCat as 'creative' | 'functional'} items={promptLibItems} loading={promptLibLoading} />
          )}
          {mode === 'tools' && (
            <ToolsDetail category={activeCat} tools={toolTemplates} onUseTool={onUseTool} remoteTools={remoteTools} onImportRemoteTool={onImportRemoteTool} />
          )}
        </div>
      )}
    </>,
    document.body
  )
}

// ========== 各库详情面板 ==========

function NodesDetail({
  category,
  groupedNodes,
  search,
  setSearch,
  onDragNodeStart,
  onTapNode,
}: {
  category: string
  groupedNodes: Record<string, NodeInfo[]>
  search: string
  setSearch: (s: string) => void
  onDragNodeStart?: (e: React.DragEvent, node: NodeInfo) => void
  onTapNode?: (node: NodeInfo) => void
}) {
  const allNodes = groupedNodes[category] || []
  const filtered = search.trim()
    ? allNodes.filter(
        (n) =>
          n.label.toLowerCase().includes(search.toLowerCase()) ||
          n.nodeType.toLowerCase().includes(search.toLowerCase()) ||
          (n.description || '').toLowerCase().includes(search.toLowerCase())
      )
    : allNodes
  return (
    <div className="flex flex-col h-full max-h-[480px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/50 bg-gradient-to-r from-accent/6 via-white/20 to-transparent">
        <span className="grid place-items-center w-6 h-6 rounded-lg bg-accent/10" style={{ color: categoryColors[category] || '#8C8C8C' }}>{categoryIcons[category]}</span>
        <Text className="text-xs font-semibold flex-1">{categoryLabels[category] || category}</Text>
        <span className="text-[10px] text-text-disabled">{allNodes.length} 个节点</span>
        <Input
          size="small"
          placeholder="搜索节点…"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          prefix={<SearchOutlined className="text-text-disabled" />}
          className="!w-32"
        />
      </div>
      <div className="flex-1 overflow-y-auto aigc-hub-scrollbar p-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">
            {search.trim() ? '未找到匹配节点' : '该分类暂无节点'}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((n) => (
              <NodeChip key={n.id} node={n} onDragStart={onDragNodeStart} onTap={onTapNode} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function NodeChip({ node, onDragStart, onTap }: { node: NodeInfo; onDragStart?: (e: React.DragEvent, n: NodeInfo) => void; onTap?: (n: NodeInfo) => void }) {
  return (
    <Tooltip
      placement="right"
      title={
        <div className="max-w-xs">
          <Text className="text-xs text-white">{node.description}</Text>
          {Object.keys(node.inputs).length > 0 && (
            <div className="mt-1">
              <Text className="text-xs text-white/70">输入:</Text>
              {Object.entries(node.inputs).map(([key, port]) => (
                <div key={key} className="text-xs text-white/60 ml-2">
                  {port.label} ({key}): {port.type} {port.required ? '*' : ''}
                </div>
              ))}
            </div>
          )}
          {Object.keys(node.outputs).length > 0 && (
            <div className="mt-1">
              <Text className="text-xs text-white/70">输出:</Text>
              {Object.entries(node.outputs).map(([key, port]) => (
                <div key={key} className="text-xs text-white/60 ml-2">
                  {port.label} ({key}): {port.type}
                </div>
              ))}
            </div>
          )}
        </div>
      }
    >
      <div
        draggable
        onDragStart={(e) => onDragStart?.(e, node)}
        onClick={() => onTap?.(node)}
        className="flex items-center gap-2 px-2 py-[5px] rounded-md border border-border bg-surface hover:border-primary hover:bg-primary-light hover:shadow-[0_2px_8px_rgba(2,6,23,0.08)] cursor-grab transition-all select-none group/chip"
        title={node.label}
      >
        <span className="shrink-0" style={{ color: categoryColors[node.category] || '#8C8C8C' }}>{categoryIcons[node.category]}</span>
        <Text className="text-[11px] font-medium truncate flex-1">{node.label}</Text>
        <span className="shrink-0 text-[9px] text-text-disabled font-mono">{node.nodeType}</span>
      </div>
    </Tooltip>
  )
}

// 提示词库（原预设库）：creative=创作型成品（瀑布流图选用）/ functional=功能型模板（标题+描述选用）
type PromptLibItem = {
  id: string
  title: string
  content: string
  category: string
  kind: string
  coverUrl: string | null
  useCount: number
}

function PromptLibDetail({ kind, items, loading }: { kind: 'creative' | 'functional'; items: PromptLibItem[]; loading: boolean }) {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<PromptLibItem | null>(null)
  const copy = async (it: PromptLibItem) => {
    try {
      await navigator.clipboard.writeText(it.content)
      setCopiedId(it.id)
      setTimeout(() => setCopiedId(null), 2000)
      // 走 apiFetch（Q-810）：原先裸 fetch 且 .catch 吞掉，会话过期时这条「使用计数」静默丢失
      void apiFetch(`/api/prompts/${it.id}/use`, { method: 'POST', silent401: true })
    } catch { /* 剪贴板失败忽略 */ }
  }
  const list = items.filter((p) => p.kind === kind)
  const [q, setQ] = useState('')
  const filtered = q.trim() ? list.filter((p) => p.title.includes(q.trim()) || p.content.includes(q.trim()) || p.category.includes(q.trim())) : list
  return (
    <div className="flex flex-col h-full max-h-[480px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/50 bg-gradient-to-r from-accent/6 via-white/20 to-transparent">
        <span className="grid place-items-center w-6 h-6 rounded-lg bg-accent/10 text-accent">{kind === 'creative' ? <PictureOutlined /> : <FileTextOutlined />}</span>
        <Text className="text-xs font-semibold flex-1">{kind === 'creative' ? '创作型成品提示词' : '功能型模板提示词'}</Text>
        <span className="text-[10px] text-text-disabled">{list.length} 条</span>
      </div>
      <div className="px-2 pt-2">
        <Input
          size="small"
          allowClear
          placeholder="搜索提示词…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="!rounded-lg"
        />
      </div>
      <div className="flex-1 overflow-y-auto aigc-hub-scrollbar p-2">
        {loading ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">加载中…</div>
        ) : list.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">{kind === 'creative' ? '暂无创作型成品提示词（可在侧边栏提示词库发布）' : '暂无功能型模板提示词'}</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">没有匹配「{q}」的提示词</div>
        ) : kind === 'creative' ? (
          // 创作型：瀑布流图片墙，hover 出复制按钮，点击弹详情
          <div className="columns-2 gap-2 [column-fill:balance] max-sm:columns-1">
            {filtered.map((p) => (
              <div key={p.id} className="group relative mb-2 break-inside-avoid overflow-hidden rounded-lg border border-border bg-surface cursor-pointer hover:border-accent/60" onClick={() => setPreviewing(p)}>
                {p.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={toProxyUrl(p.coverUrl)} alt={p.title} loading="lazy" className="w-full object-cover" />
                ) : (
                  <div className="grid aspect-square w-full place-items-center bg-accent-soft/50 text-[10px] text-text-disabled">{p.category}</div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition group-hover:opacity-100">
                  <div className="truncate text-[10px] text-white">{p.title}</div>
                  <Button size="small" className="!h-5 !px-1.5 !text-[10px] mt-1" onClick={(e) => { e.stopPropagation(); void copy(p) }}>
                    {copiedId === p.id ? '已复制' : '复制'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // 功能型：标题+描述卡片，hover 预览全文 tooltip，点击弹详情
          <div className="space-y-1.5">
            {filtered.map((p) => (
              <Tooltip key={p.id} title={<span className="whitespace-pre-wrap text-[11px]">{p.content.slice(0, 400)}</span>} placement="left">
                <div className="group cursor-pointer rounded-lg border border-border bg-surface p-2.5 hover:border-accent/60 transition-all" onClick={() => setPreviewing(p)}>
                  <div className="flex items-center gap-1.5">
                    <Text className="text-xs font-medium truncate flex-1">{p.title}</Text>
                    <span className="shrink-0 text-[9px] text-text-disabled">{p.category}</span>
                  </div>
                  <Text className="block text-[11px] text-text-secondary mt-0.5 leading-snug line-clamp-2">{p.content}</Text>
                  <Button size="small" className="!h-5 !px-1.5 !text-[10px] mt-1.5 opacity-0 group-hover:opacity-100 transition" onClick={(e) => { e.stopPropagation(); void copy(p) }}>
                    {copiedId === p.id ? '已复制' : '复制提示词'}
                  </Button>
                </div>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {/* 详情弹层：完整提示词 + 复制 */}
      {previewing && (
        <div className="fixed inset-0 z-[1100] grid place-items-center bg-black/45 p-6" onClick={() => setPreviewing(null)}>
          <div className="relative w-full max-w-lg rounded-2xl bg-surface p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="关闭"
              title="关闭"
              onClick={() => setPreviewing(null)}
              className="absolute right-2 top-2 grid size-8 place-items-center rounded-full text-text-secondary transition hover:bg-black/5 hover:text-primary"
            >
              <CloseOutlined />
            </button>
            <Text className="text-sm font-semibold">{previewing.title}</Text>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-disabled">
              <span>{previewing.category}</span>
              {previewing.kind === 'creative' && <span>创作型成品</span>}
              {previewing.kind === 'functional' && <span>功能型模板</span>}
              <span>被使用 {previewing.useCount} 次</span>
            </div>
            {previewing.coverUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={toAssetProxyUrl(previewing.coverUrl)} alt="" className="mt-2 max-h-56 w-full rounded-lg object-cover" />
            )}
            {previewing.coverUrl && (
              <div className="mt-2">
                <MediaActionsBar
                  url={toAssetProxyUrl(previewing.coverUrl)}
                  kind="image"
                  name={previewing.title}
                  onClose={() => setPreviewing(null)}
                  align="start"
                />
              </div>
            )}
            <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-hover/50 p-3 text-[12px] leading-relaxed aigc-hub-scrollbar">{previewing.content}</div>
            <div className="mt-3 flex justify-end">
              <Button size="small" type="primary" onClick={() => void copy(previewing)}>{copiedId === previewing.id ? '已复制' : '复制提示词'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PresetsDetail({
  category,
  presets,
  onImportPreset,
}: {
  category: 'node' | 'workflow' | 'prompt'
  presets: PresetTemplate[]
  onImportPreset?: (t: PresetTemplate) => void
}) {
  const items = presets.filter((p) => p.category === category)
  const catLabel = { node: '单节点', workflow: '工作流', prompt: '提示词集' } as const
  return (
    <div className="flex flex-col h-full max-h-[480px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/50 bg-gradient-to-r from-accent/6 via-white/20 to-transparent">
        <span className="grid place-items-center w-6 h-6 rounded-lg bg-accent/10 text-accent">{category === 'node' ? <RobotOutlined /> : category === 'workflow' ? <PartitionOutlined /> : <FileTextOutlined />}</span>
        <Text className="text-xs font-semibold flex-1">{catLabel[category]}</Text>
        <span className="text-[10px] text-text-disabled">{items.length} 个模板</span>
      </div>
      <div className="flex-1 overflow-y-auto aigc-hub-scrollbar p-2">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">该分类暂无内容</div>
        ) : (
          <div className="space-y-1.5">
            {items.map((t) => (
              <div key={t.id} className="border border-border rounded-lg bg-surface p-3 hover:border-accent/60 hover:shadow-[0_2px_10px_rgba(2,6,23,0.08)] transition-all">
                <Text className="text-xs font-medium block">{t.name}</Text>
                <Text className="block text-[11px] text-text-secondary mt-1 leading-relaxed">{t.description}</Text>
                {t.category === 'prompt' ? (
                  <ul className="mt-2 space-y-1">
                    {(t.prompts || []).map((p, i) => (
                      <li key={i} className="text-[11px] text-text-secondary leading-snug">· {p}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex justify-end mt-2">
                    <Button size="small" type="primary" onClick={() => onImportPreset?.(t)}>导入到画布</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolsDetail({
  category,
  tools,
  onUseTool,
  remoteTools = [],
  onImportRemoteTool,
}: {
  category: string
  tools: WorkflowTool[]
  onUseTool?: (t: WorkflowTool) => void
  remoteTools?: Array<{ id: string; name: string; description: string | null; category: string | null; isOfficial: boolean }>
  onImportRemoteTool?: (id: string, name: string) => void
}) {
  const items = tools.filter((t) => (t.category || '其他') === category)
  const remote = remoteTools.filter((t) => (t.category || '其他') === category)
  return (
    <div className="flex flex-col h-full max-h-[480px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/50 bg-gradient-to-r from-accent/6 via-white/20 to-transparent">
        <span className="grid place-items-center w-6 h-6 rounded-lg bg-accent/10 text-accent"><ToolOutlined /></span>
        <Text className="text-xs font-semibold flex-1">{category}</Text>
        <span className="text-[10px] text-text-disabled">{items.length + remote.length} 个工具</span>
      </div>
      <div className="flex-1 overflow-y-auto aigc-hub-scrollbar p-2">
        {items.length === 0 && remote.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-text-disabled">该分类暂无工具</div>
        ) : (
          <div className="space-y-1.5">
            {remote.map((t) => (
              <div key={`remote-${t.id}`} className="border border-accent/25 rounded-lg bg-accent-soft/40 p-3 hover:border-accent/60 transition-all">
                <div className="flex items-center gap-1.5">
                  <Text className="text-xs font-medium">{t.name}</Text>
                  {t.isOfficial && <span className="rounded bg-accent px-1 text-[9px] text-white">官方</span>}
                  <span className="ml-auto text-[9.5px] text-text-disabled">工具箱</span>
                </div>
                {t.description && <Text className="block text-[11px] text-text-secondary mt-1 leading-relaxed line-clamp-2">{t.description}</Text>}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-text-disabled">导入画布调整后可再发布</span>
                  <Button size="small" onClick={() => onImportRemoteTool?.(t.id, t.name)}>导入画布</Button>
                </div>
              </div>
            ))}
            {items.map((t) => (
              <div key={t.id} className="border border-border rounded-lg bg-surface p-3 hover:border-accent/60 hover:shadow-[0_2px_10px_rgba(2,6,23,0.08)] transition-all">
                <Text className="text-xs font-medium block">{t.name}</Text>
                <Text className="block text-[11px] text-text-secondary mt-1 leading-relaxed">{t.description}</Text>
                <div className="flex items-center justify-between mt-2">
                  <div className="flex gap-2">
                    {t.inputs.length > 0 && <Tag style={{ fontSize: 10 }} className="!mr-0">一键输入 ×{t.inputs.length}</Tag>}
                    {t.outputs.length > 0 && <Tag style={{ fontSize: 10 }} className="!mr-0">一键输出 ×{t.outputs.length}</Tag>}
                  </div>
                  <Button size="small" type="primary" onClick={() => onUseTool?.(t)}>使用工具</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
