 'use client'

/**
 * 沉浸式 Composer 输入条（创作工作区专用，2026-11-08）。
 *
 * ===== 与经典操作面板的关系 =====
 * 这是 slots 的**第二个渲染器**，不是新链路：同一份槽位数据、同一套 values、
 * 同一套校验/预估/扣费/执行。工具 tags 带 'composer' 才启用（试点：图像生成/视频生成），
 * 其余工具一律走经典右侧面板。槽位无法用 chip 表达的（多分支 choice 等）不启用 composer。
 *
 * ===== 形态（对齐 Kawa 参考稿）=====
 *   [+] 素材贴片们 | 描述输入（主输入，自动增高） | [方式 chip][模型 chip][规格 chip] [⟳ 生成]
 * 上传从「大框」变「贴片 chip」：点 chip 弹出对应素材口的上传器，传完显示缩略图。
 * 模型/规格收进 Popover（复用 ModelPicker 与 SlotControl，不重写任何控件）。
 */

import { useMemo, useState } from 'react'
import { Popover } from 'antd'
import { ThunderboltFilled, EditOutlined, SettingOutlined, LoadingOutlined } from '@ant-design/icons'
import { ModelOptionRow, MODEL_TYPE_FILTER } from '@/components/tools/ModelPicker'
import { SlotControl, type ToolSlot, type ModelOption } from '@/app/(app)/tools/[slug]/slot-controls'
import {
  describeVideoMediaSlots, getVideoCapabilities, isSelectableVideoModel,
  resolveVideoMediaSlots, slotVisibleInVideoMode, sortVideoModes, VIDEO_MODE_LABELS,
} from '@/lib/video-capabilities'
import { CreateModePicker, type CreateMode } from './CreateModePicker'
import { ComposerFan } from './ComposerFan'

type MessageApi = { success: (t: string) => void; error: (t: string) => void; warning: (t: string) => void; info: (t: string) => void }

export interface ComposerBarProps {
  toolName: string
  createMode?: CreateMode
  onCreateModeChange?: (mode: CreateMode) => void
  slots: ToolSlot[]
  values: Record<string, unknown>
  models: ModelOption[]
  message: MessageApi
  /** 视频模型的生成方式（模型声明 modes 时由父组件算好传入） */
  videoMode?: string
  videoModes?: string[]
  onVideoModeChange?: (mode: string) => void
  /** 图像合并工具的自动方式：有参考图 = 图生图（纯展示，不参与执行分支） */
  hasReferenceImage: boolean
  estimate: { runs: number; points: number; beans: number; uncertain: boolean }
  exact: { points: number; beans: number } | null
  running: boolean
  uploading: number
  missingCount: number
  onChangeSlot: (slotId: string, value: unknown) => void
  onUploadActivityChange: (active: boolean) => void
  /** 整个创作面板的拖拽/粘贴落点：文件交给父级写入上传槽 */
  onFilesDropped?: (files: File[]) => void
  onRun: () => void
}

export function ComposerBar({
  toolName, slots, values, models, message, createMode, onCreateModeChange,
  videoMode, videoModes, onVideoModeChange,
  hasReferenceImage,
  estimate, exact, running, uploading, missingCount,
  onChangeSlot, onUploadActivityChange, onRun,
  onFilesDropped,
}: ComposerBarProps) {
  const [modelPopOpen, setModelPopOpen] = useState(false)
  const [specPopOpen, setSpecPopOpen] = useState(false)
  const [morePopOpen, setMorePopOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const classify = useMemo(() => {
    const text = slots.filter((s) => s.type === 'text')
    const uploads = slots.filter((s) => s.type === 'upload')
    const modelSlots = slots.filter((s) => s.type === 'model')
    const ratioSlots = slots.filter((s) => s.type === 'ratio')
    // choice / number / 其余 text（如预设候选的辅助文案口）→ 收进「更多」
    const primaryText = text[0]
    const rest = slots.filter((s) => s !== primaryText
      && !uploads.includes(s) && !modelSlots.includes(s) && !ratioSlots.includes(s))
    return { primaryText, uploads, modelSlots, ratioSlots, rest }
  }, [slots])

  const modelSlot = classify.modelSlots[0]
  const selectedModelId = modelSlot && typeof values[modelSlot.id] === 'string' ? (values[modelSlot.id] as string) : ''
  const specSlot = classify.ratioSlots[0]
  // 模型候选：按槽位声明的类型过滤（与 ModelPicker 同口径），创作区直接列在弹层里，不再套一层下拉
  const modelChoices = useMemo(() => {
    const want = MODEL_TYPE_FILTER[(modelSlot?.modelType as string) ?? 'IMAGE'] ?? ['IMAGE']
    return models.filter((m) => want.includes(m.type) && isSelectableVideoModel(m))
  }, [models, modelSlot?.modelType])

  // 所选视频模型的能力：全能参考要按它决定显示图/音频/视频口
  const videoCap = useMemo(() => {
    if (modelSlot?.modelType !== 'VIDEO') return null
    const m = models.find((x) => x.id === selectedModelId)
    return m ? getVideoCapabilities(m) : null
  }, [models, selectedModelId, modelSlot?.modelType])
  const mediaSlots = videoCap ? resolveVideoMediaSlots(videoCap) : null
  // 素材贴片按「生成方式」显隐，和经典面板/必填校验同一口径
  const visibleUploads = useMemo(
    () => classify.uploads.filter((s) => slotVisibleInVideoMode(s, videoMode, mediaSlots)),
    [classify.uploads, videoMode, mediaSlots],
  )

  const pts = exact ? exact.points : estimate.points
  const bns = exact ? exact.beans : estimate.beans

  const acceptFiles = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) {
      message.warning('创作面板拖拽目前支持图片，视频/音频请点对应素材按钮选择')
      return
    }
    onFilesDropped?.(images)
  }

  // 方式 chip：视频用模型声明的 modes；图像合并工具按「有没有参考图」自动显示
  const modeChip = videoModes && videoModes.length >= 2 && videoMode && onVideoModeChange ? (
    <Popover
      classNames={{ root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' }}
      trigger="click"
      placement="top"
      content={
        <div className="flex flex-col gap-1">
          {sortVideoModes(videoModes).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onVideoModeChange(m)}
              className={`composer-chip w-full items-start justify-start ${videoMode === m ? '' : 'opacity-70'}`}
              data-active={videoMode === m ? 'true' : undefined}
            >
              <span className="flex flex-col items-start">
                <span>{VIDEO_MODE_LABELS[m] ?? m}</span>
                {m === 'multiReference' && mediaSlots && (
                  <span className="text-[10px] text-black/40">支持 {describeVideoMediaSlots(mediaSlots)}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      }
    >
      <button type="button" className="composer-chip" data-active="true">
        <span className="size-1.5 rounded-full bg-accent" />
        {VIDEO_MODE_LABELS[videoMode] ?? videoMode}
      </button>
    </Popover>
  ) : modelSlot?.modelType === 'VIDEO' ? null : hasReferenceImage ? (
    <span className="composer-chip" data-active="true">
      <span className="size-1.5 rounded-full bg-accent" />
      图生图
    </span>
  ) : (
    <span className="composer-chip">
      <span className="size-1.5 rounded-full bg-black/25" />
      文生图
    </span>
  )

  return (
    <div className="relative w-full flex justify-center">
    {collapsed && (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="composer-rail pointer-events-auto absolute bottom-6 right-0 flex flex-col items-center gap-2 px-2.5 py-4 text-[12px] font-medium backdrop-blur-xl backdrop-saturate-150"
        style={{ writingMode: 'vertical-rl' }}
        aria-label="展开创作面板"
        data-guide="composer-collapsed"
      >
        <span className="brand-gradient-bg grid size-7 place-items-center rounded-full text-white shadow-[inset_0_-2px_3px_rgba(0,0,0,0.15),0_3px_8px_rgba(125,80,224,0.3)]">
          <EditOutlined className="text-[13px]" />
        </span>
        创作面板
      </button>
    )}
    <div
      data-guide="composer"
      aria-hidden={collapsed}
      inert={collapsed}
      onDragEnter={(event) => {
        if (!onFilesDropped || visibleUploads.length === 0) return
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (!onFilesDropped || visibleUploads.length === 0) return
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragActive(false)
      }}
      onDrop={(event) => {
        setDragActive(false)
        if (!onFilesDropped || visibleUploads.length === 0) return
        const files = Array.from(event.dataTransfer.files)
        if (files.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        acceptFiles(files)
      }}
      onPaste={(event) => {
        if (!onFilesDropped || visibleUploads.length === 0) return
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return
        event.preventDefault()
        acceptFiles(files)
      }}
      className={`composer-shell relative w-[min(860px,100%)] p-3 backdrop-blur-2xl backdrop-saturate-150 sm:p-4 ${collapsed ? 'pointer-events-none translate-y-6 opacity-0' : 'pointer-events-auto translate-y-0 opacity-100'}`}
    >
      <div className="composer-sheen" />
      {dragActive && (
        <div className="pointer-events-none absolute inset-1 z-40 grid place-items-center rounded-[26px] border-2 border-dashed border-accent/60 bg-white/80 text-center backdrop-blur-sm">
          <div>
            <div className="text-sm font-medium text-accent">松手放入参考素材</div>
            <div className="mt-1 text-xs text-text-muted">图片会直接进入当前素材槽；也可以 Ctrl+V 粘贴</div>
          </div>
        </div>
      )}
      <div className="relative mb-2 flex items-center justify-between px-1 text-xs text-black/45">
        <span className="font-medium text-black/55">{toolName}</span>
        <button type="button" onClick={() => setCollapsed(true)} aria-label="收起创作面板" className="rounded-full px-2.5 py-1 transition hover:bg-white/70 hover:text-accent">收起</button>
      </div>
      {/* 素材贴片行 */}
      {(visibleUploads.length > 0 || classify.rest.length > 0) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {visibleUploads.map((slot) => (
            <ComposerFan
              key={slot.id}
              slot={slot}
              value={values[slot.id]}
              models={models}
              selectedModelId={selectedModelId || undefined}
              videoMode={videoMode}
              message={message}
              onChangeSlot={onChangeSlot}
              onUploadActivityChange={onUploadActivityChange}
            />
          ))}
          {classify.rest.length > 0 && (
            <Popover
              classNames={{ root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' }}
              open={morePopOpen}
              onOpenChange={setMorePopOpen}
              trigger="click"
              placement="topRight"
              content={
                <div className="max-h-[50vh] w-72 space-y-3 overflow-y-auto pr-1">
                  {classify.rest.map((slot) => (
                    <SlotControl
                      key={slot.id}
                      slot={slot}
                      value={values[slot.id]}
                      models={models}
                      message={message}
                      onChange={(v) => onChangeSlot(slot.id, v)}
                    />
                  ))}
                </div>
              }
            >
              <button type="button" className="composer-chip">
                <SettingOutlined className="text-[12px]" /> 更多设置
              </button>
            </Popover>
          )}
        </div>
      )}

      {/* 主行：描述输入 + 生成 */}
      <div className="flex items-end gap-2">
        {classify.primaryText ? (
          <textarea
            value={typeof values[classify.primaryText.id] === 'string' ? (values[classify.primaryText.id] as string) : ''}
            onChange={(e) => onChangeSlot(classify.primaryText!.id, e.target.value)}
            placeholder={classify.primaryText.description || `描述你想生成的${toolName.includes('视频') ? '画面与运镜' : '图片'}…`}
            rows={2}
            className="max-h-32 min-h-[60px] min-w-0 flex-1 resize-y border-0 bg-transparent px-2 py-2 text-sm leading-relaxed text-black/80 outline-none placeholder:text-black/35"
          />
        ) : (
          <div className="flex-1 rounded-xl border border-dashed border-black/12 px-3 py-2 text-[12px] text-black/35">这个工具没有文字输入</div>
        )}
        <button
          type="button"
          onClick={onRun}
          disabled={running || uploading > 0}
          title={missingCount > 0 ? `还有 ${missingCount} 项必填未完成` : '开始生成'}
          className="brand-gradient-bg flex h-11 shrink-0 items-center gap-2 rounded-2xl px-6 text-[14px] font-medium text-white shadow-[0_8px_22px_rgba(125,80,224,0.34),inset_0_-2px_3px_rgba(0,0,0,0.12)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 motion-reduce:transform-none"
        >
          {running || uploading > 0 ? <LoadingOutlined /> : <ThunderboltFilled />}
          生成
        </button>
      </div>

      {/* 参数 chips 行 */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/5 pt-3">
        {createMode && onCreateModeChange && <CreateModePicker value={createMode} onChange={onCreateModeChange} />}
        {modeChip}
        {modelSlot && (
          <Popover
            classNames={{ root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' }}
            open={modelPopOpen}
            onOpenChange={setModelPopOpen}
            trigger="click"
            placement="top"
            content={(
              <div className="max-h-[50vh] w-[380px] overflow-y-auto overflow-x-hidden p-1">
                {modelChoices.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-black/40">暂无可用的{modelSlot.modelType === 'VIDEO' ? '视频' : '图片'}模型</div>
                ) : (
                  modelChoices.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => { onChangeSlot(modelSlot.id, m.id); setModelPopOpen(false) }}
                      className={`block w-full rounded-xl px-2.5 py-2 text-left transition ${
                        m.id === selectedModelId
                          ? 'bg-accent/10 text-accent'
                          : 'text-black/75 hover:bg-white/70'
                      }`}
                    >
                      <ModelOptionRow m={m} />
                    </button>
                  ))
                )}
              </div>
            )}
          >
            <button
              type="button"
              className="composer-chip"
              style={selectedModelId ? undefined : { borderColor: 'rgba(245,158,11,0.45)', background: 'rgba(255,251,235,0.9)', color: '#b45309' }}
            >
              {(() => {
                const m = models.find((x) => x.id === selectedModelId)
                return m ? m.name : '选择模型'
              })()}
            </button>
          </Popover>
        )}
        {specSlot && (
          <Popover
            classNames={{ root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' }}
            open={specPopOpen}
            forceRender
            onOpenChange={setSpecPopOpen}
            trigger="click"
            placement="top"
            content={
              <div className="w-72">
                <SlotControl
                  slot={specSlot}
                  value={values[specSlot.id]}
                  models={models}
                  selectedModelId={selectedModelId || undefined}
                  needsModelFirst={!!modelSlot}
                  message={message}
                  onChange={(v) => onChangeSlot(specSlot.id, v)}
                />
              </div>
            }
          >
            <button type="button" className="composer-chip">
              {(() => {
                const v = values[specSlot.id] as { ratio?: string; resolution?: string; duration?: number; tier?: string } | undefined
                const parts: string[] = []
                if (v?.ratio) parts.push(v.ratio)
                if (v?.resolution) parts.push(v.resolution)
                if (v?.duration) parts.push(`${v.duration}s`)
                if (v?.tier) parts.push(v.tier)
                return parts.length > 0 ? parts.join(' · ') : (specSlot.label || '规格')
              })()}
            </button>
          </Popover>
        )}
        {(pts > 0 || bns > 0) && (
          <span className="flex items-center gap-1 text-[11.5px] text-black/40">
            {pts > 0 && <span>{exact ? '' : '约 '}{pts} 积分</span>}
            {pts > 0 && bns > 0 && <span>+</span>}
            {bns > 0 && <span>{exact ? '' : '约 '}{bns} 豆</span>}
          </span>
        )}
        {estimate.runs > 1 && (
          <span className="composer-chip" data-active="true">×{estimate.runs}</span>
        )}
        {missingCount > 0 && (
          <span className="text-[11.5px] text-amber-600">{missingCount} 项必填未完成</span>
        )}
      </div>
    </div>
    </div>
  )
}
