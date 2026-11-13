'use client'

/**
 * 画布节点卡片（Q-D25 / Q-D801：从 canvas/page.tsx 抽出的独立 memo 组件）。
 *
 * 抽它的理由：这个组件**全部依赖都走 props**（node / 选中态 / 各类回调 / 尺寸），
 * 不闭包画布页里的任何 state —— 所以搬出去是**纯搬移**，渲染结果逐行不变。
 *
 * 而画布页本身（3500+ 行、约 50 个 useState / 24 个 useEffect）**不是**能这样切的：
 * 它的体量来自「一个组件持有全部状态」，拆它必须先做**行为相关**的抽 hook（改 Hook 归属与依赖），
 * 那需要交互验证，不能盲做。拆解计划见台账 Q-301 / Q-D25 / Q-D801。
 */

import { memo, useRef } from 'react'
import { Typography } from 'antd'
const { Text } = Typography
import { ExpandOutlined } from '@ant-design/icons'
import { NODE_HEADER_HEIGHT, NODE_PADDING, categoryColors, statusColors, typeColors, getPortPosition, visibleInputKeys, estimateNodeHeight, nodeWidthFor, resolveTargetInputKey, type NodeInfo, type CanvasNode } from '@/lib/canvas-utils'
import { canConnect } from '@/lib/connection-compat'
import { dispatchNodeBody, dispatchParamBar, dispatchPromptPanel, hasResultCard, TextResult, TextInputBody, type NodeBodyCtx } from '@/components/canvas/node-bodies'
import { categoryIcons } from '@/components/canvas/canvas-node-meta'

export const CanvasNodeCard = memo(function CanvasNodeCard({
  node,
  info,
  selected,
  output,
  cropImageUrl,
  doodleImageUrl,
  statusColor,
  highlighted,
  onHeaderPointerDown,
  onPortPointerDown,
  onPortPointerUp,
  onNodeMenu,
  onUpdateInput,
  onOpenWorkbench,
  dragSourceType,
  modelOptions,
  onPreviewImage,
  onPreviewVideo,
  running,
  onRun,
  refImages,
  onUploadFiles,
  cardOpen,
  measuredHeight,
  onDeriveNode,
}: {
  node: CanvasNode
  info: NodeInfo | undefined
  selected: boolean
  output?: Record<string, unknown> | null
  cropImageUrl?: string
  doodleImageUrl?: string
  statusColor?: string
  highlighted?: boolean
  onHeaderPointerDown: (e: React.PointerEvent, nodeId: string) => void
  onPortPointerDown: (e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => void
  onPortPointerUp: (e: React.PointerEvent, nodeId: string, portKey: string, side: 'input' | 'output') => void
  onNodeMenu: (point: { clientX: number; clientY: number }, nodeId: string, fromTouch?: boolean) => void
  onUpdateInput: (nodeId: string, key: string, value: unknown) => void
  onOpenWorkbench: (nodeId: string) => void
  dragSourceType?: string
  modelOptions?: { id: string; name: string; type: string; metadata?: Record<string, unknown> | null }[]
  onPreviewImage: (src: string) => void
  onPreviewVideo: (src: string) => void
  running: boolean
  onRun: () => void
  refImages: string[]
  onUploadFiles: (files: FileList | File[]) => void
  cardOpen: boolean
  measuredHeight?: number
  onDeriveNode?: (sourceNodeId: string, actionType: 'remix' | 'face-doodle' | 'animate' | 'crop' | 'vision' | 'upscale', imageUrl: string) => void
}) {
  const allInputKeys = info ? Object.keys(info.inputs) : []
  // 图像/视频生成节点：模型/尺寸等参数只在面板编辑，不占端口（与连线锚点共用同一套过滤）
  const inputKeys = node.type ? visibleInputKeys(node.type, info) : allInputKeys
  const outputKeys = info ? Object.keys(info.outputs) : []
  // 卡片高度按可见端口数算（panel-only 参数不占端口行，避免节点底部留白）
  const height = estimateNodeHeight(info, inputKeys.length, outputKeys.length, node.type)
  const color = categoryColors[node.category] || '#8C8C8C'
  // 节点执行状态边框色
  const showStatus = !!statusColor && statusColor !== statusColors.idle
  // 端口悬浮化：每节点一进一出两颗球，hover 节点时弹出；拖线中常显并置灰不兼容端
  const inKey = inputKeys[0]
  const outKey = outputKeys[0]
  const inType = inKey && info ? info.inputs[inKey].type : 'string'
  const outType = outKey && info ? info.outputs[outKey].type : 'string'
  // 展示球校正：用 resolveTargetInputKey 按主流源类型（image/string）找到真正落点 key，
  // 让球色、hover 标题与实际连线语义一致（图片拖线→LLM 时球=image 口，不显示 prompt）
  const displayInKey = node.type === 'llm-chat' && info
    ? resolveTargetInputKey('image', info, node.type) ?? inKey
    : inKey
  const displayInPort = displayInKey && info ? info.inputs[displayInKey] : undefined
  const displayInType = displayInPort?.type ?? inType
  const isDraggingConn = dragSourceType !== undefined
  const inCompatible = !isDraggingConn || canConnect(dragSourceType, inType)
  // 端口球 y：与 getPortPosition 同一套公式 + 同一份数据（实测高度优先），
  // 卡身内容撑高后球和连线终点保持同一点
  const effHeight = measuredHeight ?? height
  const portY = hasResultCard(node.type)
    ? Math.max(NODE_PADDING, effHeight / 2)
    : NODE_HEADER_HEIGHT + Math.max(NODE_PADDING, (effHeight - NODE_HEADER_HEIGHT) / 2)
  // 专属卡身：生成/媒体类节点用「上参数条+中结果+下输入框」内联布局，替代通用摘要区
  const stopProp = (e: React.PointerEvent) => e.stopPropagation()
  const bodyCtx: NodeBodyCtx = {
    node, output, modelOptions: modelOptions ?? [], running,
    onRun, onUpdateInput, onPreviewImage, onPreviewVideo,
    refImages, stopPropagation: stopProp,
    cropImageUrl: cropImageUrl || undefined,
    doodleImageUrl: doodleImageUrl || undefined,
    onDeriveNode,
  }
  const customBody = dispatchNodeBody(node.type, bodyCtx, { onUploadFiles, onOpenWorkbench })
  // 浮动参数层：点击节点卡片后，上方弹出参数条、下方弹出填写面板（液态玻璃横条）
  const paramBar = cardOpen ? dispatchParamBar(node.type, bodyCtx) : null
  const promptPanel = cardOpen ? dispatchPromptPanel(node.type, bodyCtx) : null
  // 上传节点：执行输出与自身输入相同（透传）时不重复渲染结果区
  const isUploadPassThrough = (node.type === 'image-upload' || node.type === 'image-upload-batch') &&
    output && String((output as Record<string, unknown>).imageUrl ?? '') === String(node.inputs.image ?? '')

  // 关键输入摘要:节点本体展示 prompt/内容 + 模型名,用户无需点开属性面板即可核对
  const PRIMARY_TEXT_KEYS = ['prompt', 'content', 'text', 'description', 'json']
  const primaryInput = (() => {
    const ins = node.inputs as Record<string, unknown>
    for (const k of PRIMARY_TEXT_KEYS) {
      const v = ins[k]
      if (v !== undefined && v !== null && v !== '') return String(v)
    }
    return null
  })()
  const modelName = (() => {
    const mid = (node.inputs as Record<string, unknown>).model
    if (typeof mid !== 'string' || !mid) return null
    return modelOptions?.find((m) => m.id === mid)?.name || null
  })()

  // 输入图片预览：上传节点在节点本体直接显示缩略图（多图带编号，方便区分 图1/图2/图3…）
  const inputImages = (() => {
    const ins = node.inputs as Record<string, unknown>
    if (node.type === 'image-upload-batch' && Array.isArray(ins.images)) {
      return (ins.images as string[]).filter((v) => typeof v === 'string' && /^(data:image|https?:|\/)/.test(v))
    }
    const single = ins.image ?? ins.imageUrl
    if (typeof single === 'string' && /^(data:image|https?:|\/)/.test(single)) return [single]
    return []
  })()

  // 触屏长按(>450ms)弹节点菜单；捕获阶段监听以在 header/端口 stopPropagation 前收到事件
  const longPressRef = useRef<{ timer: number | null; x: number; y: number }>({ timer: null, x: 0, y: 0 })
  const clearLongPress = () => {
    if (longPressRef.current.timer !== null) {
      window.clearTimeout(longPressRef.current.timer)
      longPressRef.current.timer = null
    }
  }
  const handleCardPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    if ((e.target as HTMLElement).closest('[data-port]')) return // 端口拖连线不触发长按
    clearLongPress()
    const x = e.clientX
    const y = e.clientY
    longPressRef.current = {
      timer: window.setTimeout(() => {
        longPressRef.current.timer = null
        onNodeMenu({ clientX: x, clientY: y }, node.id, true)
      }, 450),
      x,
      y,
    }
  }
  const handleCardPointerMoveCapture = (e: React.PointerEvent) => {
    const lp = longPressRef.current
    if (lp.timer !== null && (Math.abs(e.clientX - lp.x) > 8 || Math.abs(e.clientY - lp.y) > 8)) {
      clearLongPress() // 位移超阈值 → 是拖拽不是长按
    }
  }
  const handleCardPointerEndCapture = () => clearLongPress()

  return (
    <div
      data-canvas-node-id={node.id}
      data-canvas-node-type={node.type}
      className={`group absolute rounded-lg shadow-sm border bg-white select-none transition-[box-shadow] ${
        selected ? 'ring-2 ring-primary shadow-md' : ''
      } ${highlighted ? 'copilot-node-highlight' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        border: showStatus ? `2px solid ${statusColor}` : undefined,
        width: nodeWidthFor(node.type),
        minHeight: height,
      }}
      onPointerDownCapture={handleCardPointerDownCapture}
      onPointerMoveCapture={handleCardPointerMoveCapture}
      onPointerUpCapture={handleCardPointerEndCapture}
      onPointerCancelCapture={handleCardPointerEndCapture}
      onContextMenu={(e) => { e.preventDefault(); onNodeMenu({ clientX: e.clientX, clientY: e.clientY }, node.id) }}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        // 整卡可拖：排除端口、按钮、表单控件、粘贴区、可选中文本区(data-selectable)。
        // 拖拽柄(data-node-drag-handle)显式放行——text-input 等全输入卡身的唯一拖动入口
        // 其余（图片/视频/结果文本留白/卡身空白）一律按下即拖——点图不再被吞
        const t = e.target as HTMLElement
        if (t.closest('[data-port]')) return
        if (t.closest('[data-node-header]')) return // header 自身已绑定拖动
        if (t.closest('[data-node-drag-handle]')) { onHeaderPointerDown(e, node.id); return }
        if (t.closest('button, a, input, textarea, select, [data-paste-zone], [data-selectable], .ant-btn, .ant-input, .ant-select, .ant-input-number')) return
        onHeaderPointerDown(e, node.id)
      }}
    >
      {/* Header：结果卡身节点去掉白横条标注（由卡身内浮动标注替代），仅表单类保留 */}
      {!hasResultCard(node.type) && (
        <div
          data-node-header
          className="h-[36px] flex items-center px-3 rounded-t-lg cursor-grab active:cursor-grabbing"
          style={{ backgroundColor: `${color}15`, borderBottom: `1px solid ${color}30` }}
          onPointerDown={(e) => onHeaderPointerDown(e, node.id)}
        >
          <span className="mr-2" style={{ color }}>{categoryIcons[node.category]}</span>
          {node.batch && (
            <span className="mr-1 text-[10px] leading-none px-1 py-0.5 rounded bg-primary text-white font-medium">
              ×{(node.batch.index ?? 0) + 1}
            </span>
          )}
          <Text className="text-xs font-medium truncate flex-1">{node.label}</Text>
        </div>
      )}

      {/* Body：结果卡身高度由内容自适应（短文本不撑白板），连线锚点用 ResizeObserver 实测高度；
          overflow-hidden 防媒体溢出，浮动参数层在 body 之外不受影响 */}
      <div className={`relative ${hasResultCard(node.type) ? 'overflow-hidden' : 'py-2'}`}>
        {/* 输入端口：单球悬浮——hover 节点弹出（scale+位移灵动），拖线中常显；key 取第一个可见输入，落点由 resolveTargetInputKey 校正 */}
        {inKey && (
          <div
            data-port
            data-side="input"
            data-node-id={node.id}
            data-port-key={inKey}
            className={`absolute -left-2.5 w-6 h-6 flex items-center justify-center cursor-crosshair z-20 transition-all duration-150 ease-out
              ${isDraggingConn ? 'opacity-100 scale-100' : 'opacity-0 scale-50 group-hover:opacity-100 group-hover:scale-100'}
              ${isDraggingConn && !inCompatible ? 'opacity-30 cursor-not-allowed' : ''}`}
            style={{ top: portY - 10 }}
            onPointerDown={(e) => onPortPointerDown(e, node.id, inKey, 'input')}
            onPointerUp={(e) => onPortPointerUp(e, node.id, inKey, 'input')}
            title={displayInPort?.label ?? info?.inputs[inKey].label}
          >
            <div
              className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-md"
              style={{
                backgroundColor: typeColors[displayInType],
                ...(isDraggingConn && inCompatible ? { boxShadow: '0 0 0 4px rgba(82,196,26,0.45)', transform: 'scale(1.3)' } : {}),
              }}
            />
          </div>
        )}

        {/* 输出端口：单球悬浮（同输入球交互）——专属卡身与通用卡身共用 */}
        {outKey && (
          <div
            data-port
            data-side="output"
            data-node-id={node.id}
            data-port-key={outKey}
            className="absolute -right-2.5 w-6 h-6 flex items-center justify-center cursor-crosshair z-20 transition-all duration-150 ease-out opacity-0 scale-50 group-hover:opacity-100 group-hover:scale-100"
            style={{ top: portY - 10 }}
            onPointerDown={(e) => onPortPointerDown(e, node.id, outKey, 'output')}
            onPointerUp={(e) => onPortPointerUp(e, node.id, outKey, 'output')}
            title={info?.outputs[outKey].label}
          >
            <div
              className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-md"
              style={{ backgroundColor: typeColors[outType] }}
              {...(isDraggingConn && canConnect(dragSourceType, outType) ? { boxShadow: '0 0 0 4px rgba(82,196,26,0.45)', transform: 'scale(1.3)' } : {})}
            />
          </div>
        )}

        {/* 专属卡身：生成/媒体类节点内联布局（上参数条+中结果+下输入框），跳过通用摘要/结果区 */}
        {customBody ? (
          <div className="-my-2">{customBody}</div>
        ) : (
        <>

        {/* Labels（图片/视频类节点有大图预览，隐藏标签行提升图片占用率） */}
        {!['image-upload', 'image-upload-batch', 'image-preview', 'image-generate', 'video-preview', 'video-generate'].includes(node.type) && (
          <div className="px-5">
            {inputKeys.map((key) => (
              <div key={key} className="h-[26px] flex items-center text-xs text-text-secondary truncate">
                {info?.inputs[key].label}
              </div>
            ))}
            {inputKeys.length === 0 && outputKeys.length === 0 && (
              <div className="h-[26px] flex items-center text-xs text-text-disabled">无端口</div>
            )}
          </div>
        )}

        {/* 关键输入摘要:节点本体展示 prompt/内容 + 模型名；text-input 节点已由专属卡身 TextInputBody 接管 */}
        {(primaryInput || modelName) && (
          <div className="px-5 pb-2 space-y-0.5">
            {primaryInput && (
                <div className="text-[10px] text-text-muted truncate leading-tight" title={primaryInput}>
                  {primaryInput.length > 36 ? `${primaryInput.slice(0, 36)}…` : primaryInput}
                </div>
            )}
            {modelName && <div className="text-[10px] text-primary leading-tight">模型: {modelName}</div>}
          </div>
        )}

        {/* 输入图片预览：图片类节点本体以大图为主（单图贴边铺满卡宽，多图两列网格带编号角标）；点击直接放大预览 */}
        {inputImages.length > 0 && (
          <div>
            {inputImages.length === 1 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={inputImages[0]}
                alt="图片"
                className="w-full max-h-72 object-contain rounded-b-lg bg-surface cursor-zoom-in"
                onClick={(e) => { e.stopPropagation(); onPreviewImage(inputImages[0]) }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
              />
            ) : (
              <div className="grid grid-cols-2 gap-0.5">
                {inputImages.slice(0, 6).map((img, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img}
                      alt={`图 ${i + 1}`}
                      className="h-28 w-full object-cover cursor-zoom-in"
                      onClick={(e) => { e.stopPropagation(); onPreviewImage(img) }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
                    />
                    <span className="absolute top-0.5 left-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent/90 text-[9px] font-medium text-white">
                      {i + 1}
                    </span>
                  </div>
                ))}
                {inputImages.length > 6 && (
                  <span className="flex h-28 items-center justify-center bg-surface text-[10px] text-text-secondary">
                    +{inputImages.length - 6}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* 执行结果展示区：图片/视频贴边铺满卡宽，节点本体即预览；点击直接放大查看 */}
        {output && !isUploadPassThrough && (
          <div className="border-t border-surface-hover">
            {output.videoUrl ? (
              <div className="group/video relative" onPointerDown={(e) => e.stopPropagation()}>
                { }
                <video src={String(output.videoUrl)} controls className="w-full rounded-b-lg" style={{ maxHeight: 288 }} />
                {/* 悬浮放大按钮：避免整块 video 绑点击与播放/进度条冲突 */}
                <button
                  type="button"
                  title="放大播放"
                  onClick={(e) => { e.stopPropagation(); onPreviewVideo(String(output.videoUrl)) }}
                  className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
                >
                  <ExpandOutlined className="text-xs" />
                </button>
              </div>
            ) : output.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={String(output.imageUrl)}
                alt="结果"
                className="w-full max-h-72 object-contain rounded-b-lg bg-surface cursor-zoom-in"
                onClick={(e) => { e.stopPropagation(); onPreviewImage(String(output.imageUrl)) }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
              />
            ) : output.images && Array.isArray(output.images) ? (
              <div className="grid grid-cols-2 gap-0.5 pt-0.5">
                {(output.images as string[]).map((img, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={String(img)} alt={`结果${i}`} className="h-28 w-full object-cover cursor-zoom-in" onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }} onClick={(e) => { e.stopPropagation(); onPreviewImage(String(img)) }} />
                ))}
              </div>
            ) : output.text !== undefined ? (
              <TextResult text={String(output.text)} />
            ) : output.output !== undefined ? (
              <TextResult text={typeof output.output === 'object' ? JSON.stringify(output.output) : String(output.output)} />
            ) : output.result !== undefined ? (
              <TextResult text={typeof output.result === 'object' ? JSON.stringify(output.result) : String(output.result)} />
            ) : null}
          </div>
        )}
        </>
        )}
      </div>

      {/* ===== 浮动参数层（液态玻璃·紫主题）：上参数条 + 下填写面板 =====
          宽度可超节点面板（min 320/300 → max 560）；内容 flex-1 均匀分布不挤左 */}
      {(paramBar || promptPanel) && (
        <div className="pointer-events-none absolute inset-0" style={{ zIndex: 60 }}>
          {paramBar && (
            <div className="node-parambar glass-pop-in pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(100%+6px)]">
              <div className="flex items-center rounded-xl border border-accent-border/70 bg-accent-soft/80 shadow-lg shadow-accent/15 backdrop-blur-xl accent-glass">{paramBar}</div>
            </div>
          )}
          {promptPanel && (
            <div className="node-parampanel glass-pop-in pointer-events-auto absolute left-1/2 top-full -translate-x-1/2 translate-y-[6px]">
              <div className="rounded-xl border border-accent-border/70 bg-accent-soft/85 shadow-lg shadow-accent/15 backdrop-blur-xl accent-glass">{promptPanel}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
