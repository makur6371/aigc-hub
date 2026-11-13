'use client'

// 工具操作面板的槽位控件 + 成果行（从 tools/[slug]/page.tsx 抽出）
//
// 抽出的三个组件/工具都自包含：SlotControl（槽位输入）、ResultRow（成果列表行）、
// useElapsed/formatElapsed（计时）。页面文件因此只保留「数据获取 + 页面编排」。
//
// 类型 ToolSlot / ModelOption 与页面共用语义，这里重新声明保持一致（页面侧保留同名定义）。

import { useState, useEffect } from 'react'
import { App, Input, Select, Segmented } from 'antd'
import * as Icons from '@ant-design/icons'
import { SoundOutlined, VideoCameraOutlined, PictureOutlined } from '@ant-design/icons'
import { ASPECT_RATIOS, RES_TIERS, getImageCapabilities, findImageSize } from '@/lib/image-sizes'
import { toAssetProxyUrl } from '@/lib/media-url'
import { type ResultItem } from '@/stores/useToolRunStore'
import { mediaLabel, type MediaKind } from '@/lib/media-kinds'
import { MediaUploader, type UploadingFile } from '@/components/tools/MediaUploader'
import { DurationSlider } from '@/components/tools/DurationSlider'
import {
  getVideoCapabilities,
  resolveVideoMediaSlots,
  videoMediaKindForUploadPort,
  DEFAULT_VIDEO_RATIOS,
  DEFAULT_VIDEO_RESOLUTIONS,
  resolveVideoDurations,
  normalizeVideoResolution,
  slotVisibleInVideoMode,
  sortVideoModes,
  describeVideoMediaSlots,
  isContinuousDurationRange,
  VIDEO_MODE_LABELS,
} from '@/lib/video-capabilities'
import { AnimatedLogo } from '@/components/ui/AnimatedLogo'
import { GridReveal } from '@/components/ui/fx/GridReveal'
import { ConfirmButton } from '@/components/ui/fx/ConfirmButton'
import { RESULT_DRAG_MIME } from '@/app/(app)/tools/[slug]/file-drop'
import { StageFlow, buildImageStages } from '@/components/ui/StageFlow'
import { downloadResults } from '@/lib/download-results'
import { copyMediaToClipboard, isGifUrl } from '@/lib/media-clipboard'
// 模型选择器：平台唯一一份实现（价格三列 / 免费额度 / 收起态 / 设为默认）。
// 2026-10-25 从本文件内联段抽出 —— 电商 Agent 曾手写一个丢了这些能力的 <Select>。
import {
  MODEL_TYPE_FILTER,
  ModelPicker,
  readDefaultModelId,
  writeDefaultModelId,
} from '@/components/tools/ModelPicker'
import { AUTO_LLM_MODEL_ID } from '@/lib/auto-llm'

// 成果图 / 工作台共用的同源显示地址（收敛到 media-url 的唯一实现）
const displayUrl = toAssetProxyUrl

/** 模态 → 图标 React 元素（slot-controls 内部用，避免多处三元链） */
function kindIconOf(kind: string | null | undefined) {
  if (kind === 'video') return <VideoCameraOutlined />
  if (kind === 'audio') return <SoundOutlined />
  return <PictureOutlined />
}

export type ToolSlot = {
  id: string
  type: 'upload' | 'text' | 'choice' | 'model' | 'ratio' | 'number' | 'result'
  label: string
  description?: string
  required?: boolean
  targets: { nodeId: string; port: string }[]
  accept?: Array<'image' | 'video' | 'audio' | 'text'>
  multiple?: boolean
  options?: { label: string; nodeId: string; aiPolish?: boolean; tags?: string[] }[]
  single?: boolean
  dependsOn?: { slotId: string; filterByTag?: boolean; showAllWhenEmpty?: boolean }
  modelType?: string
  /** 视频上传槽的生成方式归属（合并版视频生成工具用；见 lib/tool-slots.ts 注释） */
  videoModeOnly?: 'text' | 'multiReference' | 'firstLastFrame'
  defaultRatio?: string
  defaultTier?: string
  multipliers?: number[]
  presets?: string[]
  hidden?: boolean
  status?: 'confirmed' | 'suggested'
}

export type ModelOption = { id: string; name: string; type: string; pricingLabel?: string; effectiveCostPoints?: number | null; isFree?: boolean; pricingType?: string; videoCost?: number | null; metadata?: Record<string, unknown> | null; dailyUserFreeQuota?: number | null; freeQuotaRemaining?: number | null; listPoints?: number | null; effectivePoints?: number | null; discountRatio?: number | null; discount?: number | null; unitLabel?: string }

export function SlotControl({
  slot, value, models, selectedModelId, needsModelFirst, onChange, message, dependsValue, modelPersistKey,
  videoMode, onVideoModeChange, onUploadActivityChange,
}: {
  slot: ToolSlot
  value: unknown
  models: ModelOption[]
  /** 依赖槽的当前值（如「出图方向」依赖「平台」）：用于前端过滤可选项 */
  dependsValue?: unknown
  /** model 槽位当前选中的模型 id（ratio 槽位按它过滤规格） */
  selectedModelId?: string
  /** 该工具是否有 model 槽位：为 true 时 ratio 槽位必须先选模型才可操作 */
  needsModelFirst?: boolean
  /**
   * 模型槽位的持久化 key（工具 slug + 槽位 id）。
   *
   * 用于「收起/展开 + 设为默认」：设为默认后收起成一行摘要，下次进来自动用默认模型，
   * 不用每次都展开挑。key 里带槽位 id 是为了多模型工具里各槽位独立记忆。
   */
  modelPersistKey?: string
  /**
   * 视频模型的「生成方式」（2026-11-08 面板第二步）。
   * 模型声明 modes ≥2 种时由父组件算好传入：上传框按方式显隐/标必填。
   * 未声明（单形态工具如动作迁移/对口型）时为 undefined，走原有「素材口跟随模型」逻辑。
   */
  videoMode?: string
  onVideoModeChange?: (mode: string) => void
  onChange: (v: unknown) => void
  onUploadActivityChange?: (active: boolean) => void
  message: { success: (t: string) => void; error: (t: string) => void; warning: (t: string) => void; info: (t: string) => void }
}) {
  // 上传中占位（仅 upload 槽使用）：点击/拖拽上传时立即显示 loading，避免「点了没反应」的错觉
  const [uploadingItems, setUploadingItems] = useState<UploadingFile[]>([])

  /**
   * 规格槽位的最后一道前端归一化：
   * - 图片：模型声明 sizes 后，比例/档位必须来自同一组合，不拿全局 4K 兜底
   * - 视频：比例/清晰度/时长都归一到模型 constraints
   *
   * 这里会把非法旧值写回父 state，避免 UI 显示第一项、提交时却仍带旧值。
   */
  useEffect(() => {
    if (slot.type !== 'ratio' || !selectedModelId) return
    const model = models.find((m) => m.id === selectedModelId)
    if (!model) return
    const v = (typeof value === 'object' && value !== null ? value : {}) as {
      ratio?: string
      tier?: string
      resolution?: string
      duration?: number
    }

    if ((slot.targets[0]?.port ?? '') === 'aspectRatio') {
      const cap = getVideoCapabilities(model)
      const ratios = cap.ratios.length > 0 ? cap.ratios : DEFAULT_VIDEO_RATIOS
      const resolutions = (cap.resolutions.length > 0 ? cap.resolutions : DEFAULT_VIDEO_RESOLUTIONS)
        .map((r) => normalizeVideoResolution(r))
      const durations = resolveVideoDurations(cap)
      const ratio = v.ratio && ratios.includes(v.ratio) ? v.ratio : ratios[0]
      const resolution = v.resolution && resolutions.includes(normalizeVideoResolution(v.resolution))
        ? normalizeVideoResolution(v.resolution)
        : resolutions[0]
      const duration = v.duration != null && durations.includes(v.duration) ? v.duration : durations[0]
      if (ratio !== v.ratio || resolution !== v.resolution || duration !== v.duration) {
        onChange({ ...v, ratio, resolution, duration })
      }
      return
    }

    const cap = getImageCapabilities(model)
    if (!cap.declared || cap.sizes.length === 0) return
    const ratio = v.ratio && cap.ratios.includes(v.ratio) ? v.ratio : cap.ratios[0]
    const tiers = cap.tiersByRatio[ratio] ?? []
    const tier = v.tier && tiers.includes(v.tier) ? v.tier : tiers[0]
    if (ratio !== v.ratio || tier !== v.tier) {
      onChange({ ...v, ratio, tier })
    }
  }, [slot.type, slot.targets, selectedModelId, models, value, onChange])

  // 自动套用「设为默认」的模型：进来自动选中，省去每次挑模型。
  // 只在当前没选模型时补一次（不覆盖用户本次的显式选择）。
  useEffect(() => {
    if (slot.type !== 'model') return
    if (typeof value === 'string' && value) return
    const saved = readDefaultModelId(modelPersistKey)
    if (!saved) return
    // 必须在**该槽位类型允许的模型**里（否则会给生图槽位选到视频模型）
    const mt = slot.modelType ?? 'IMAGE'
    const allowed = MODEL_TYPE_FILTER[mt] ?? [mt]
    const exists = (saved === AUTO_LLM_MODEL_ID && (mt === 'TEXT' || mt === 'VISION'))
      || models.some((m) => m.id === saved && allowed.includes(m.type))
    if (exists) onChange(saved)
    // 只在挂载/默认值变化时尝试；onChange 有意不入依赖（避免重复触发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.type, modelPersistKey, value, models])

  const labelRow = (
    <div className="mb-1 flex items-baseline gap-1.5">
      <span className="text-[13px] font-medium">{slot.label}</span>
      {slot.required && <span className="text-[12px] text-red-400">*</span>}
      {slot.description && <span className="text-[12px] text-black/40">{slot.description}</span>}
    </div>
  )

  // 新手引导锚点：按槽位类型打标记，FirstUseGuide 用它把高亮框套到对应控件上。
  // 加在根节点上（不新增包裹层）→ 布局零影响。
  const guideAnchor = slot.type === 'upload' ? 'upload'
    : slot.type === 'model' ? 'model'
    : slot.type === 'ratio' ? 'ratio'
    : slot.type === 'text' ? 'text'
    : undefined

  if (slot.type === 'upload') {
    const acceptKind = slot.accept?.[0] ?? 'image'
    const current = (Array.isArray(value) ? value : value ? [value] : []) as string[]

    const port = slot.targets[0]?.port ?? ''
    const mediaKind = videoMediaKindForUploadPort(port)
    const curModel = mediaKind ? models.find((m) => m.id === selectedModelId) : undefined
    const vCap = curModel && curModel.type === 'VIDEO' ? getVideoCapabilities(curModel) : null
    const mediaKinds = vCap ? resolveVideoMediaSlots(vCap) : null
    const maxFiles = videoMode === 'multiReference' && (mediaKind === 'video' || mediaKind === 'audio')
      ? mediaKinds?.[`${mediaKind}Max`]
      : undefined
    const multiple = maxFiles === undefined ? slot.multiple ?? false : maxFiles > 1

    const showSlot = videoMode
      ? slotVisibleInVideoMode(slot, videoMode, mediaKinds)
      : !mediaKinds || !mediaKind || mediaKinds[mediaKind]
    if (!showSlot) return null
    const slotRequired = videoMode === 'firstLastFrame'
      || (mediaKinds && mediaKind ? mediaKinds[`${mediaKind}Required`] : slot.required === true)

    return (
      <div
        data-guide={guideAnchor}
        // 操作面板落点（useFileDrop）靠这个标记识别「拖到了上传框」：
        // 命中时放行给 antd Dragger 自己处理，避免同一文件被上传两次。
        data-upload-slot
      >
        <div className="mb-1 flex items-baseline gap-1.5">
          <span className="text-[13px] font-medium">{slot.label}</span>
          {slotRequired && <span className="text-[12px] text-red-400">*</span>}
          {maxFiles !== undefined && (
            <span className="shrink-0 text-[11px] text-text-muted">已传 {current.length}/{maxFiles}</span>
          )}
          {slot.description && <span className="text-[12px] text-black/40">{slot.description}</span>}
          {mediaKinds && slotRequired && (
            <span className="ml-auto shrink-0 text-[10px] text-accent">该模型必填</span>
          )}
        </div>
        <MediaUploader
          kind={acceptKind as MediaKind}
          multiple={multiple}
          maxFiles={maxFiles}
          value={current}
          onChange={(next) => onChange(multiple || (maxFiles !== undefined && next.length > 1) ? next : (next[0] ?? ''))}
          uploading={uploadingItems}
          onUploadingChange={setUploadingItems}
          onUploadActivityChange={onUploadActivityChange}
        />
      </div>
    )
  }

  if (slot.type === 'text') {
    // 有预设候选（如文案语言）：渲染「下拉 + 可自定义」，避免用户手打错别字。
    // 选「自定义…」时切回文本框自由输入。
    if (slot.presets && slot.presets.length > 0) {
      const cur = typeof value === 'string' ? value : ''
      const isCustom = cur !== '' && !slot.presets.includes(cur)
      return (
        <div data-guide={guideAnchor}>
          {labelRow}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              className="w-full max-w-xs [&>.ant-select-selector]:!rounded-xl"
              value={isCustom ? '__custom__' : (cur || slot.presets[0])}
              onChange={(v) => onChange(v === '__custom__' ? '' : v)}
              options={[
                ...slot.presets.map((x) => ({ value: x, label: x })),
                { value: '__custom__', label: '自定义…' },
              ]}
            />
            {(isCustom || cur === '') && (
              <Input
                className="!w-40 !rounded-xl"
                value={cur}
                placeholder="自定义"
                onChange={(e) => onChange(e.target.value)}
              />
            )}
          </div>
        </div>
      )
    }
    return (
      <div data-guide={guideAnchor}>
        {labelRow}
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 16 }}
          className="!rounded-xl"
          value={typeof value === 'string' ? value : ''}
          placeholder={slot.description || '请输入内容'}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  if (slot.type === 'choice') {
    const selected = (Array.isArray(value) ? value : []) as string[]
    // 按依赖槽的值过滤可选项（多平台套图：方向随平台变化）。
    // 被过滤掉的项不再渲染，但**已在 selected 里的仍保留**，由外层在平台变化时清理，
    // 避免用户「切了平台、看不见某些已选项、却仍在提交」的脏状态。
    const dep = slot.dependsOn
    const depValue = dep ? String(dependsValue ?? '') : ''
    const visibleOptions = (() => {
      const all = slot.options ?? []
      if (!dep || !dep.filterByTag) return all
      if (!depValue) return dep.showAllWhenEmpty === false ? [] : all
      return all.filter((o) => {
        const tags = o.tags ?? []
        return tags.includes('*') || tags.includes(depValue)
      })
    })()
    const multi = slot.single !== true
    const pickedCount = selected.filter((id) => visibleOptions.some((o) => o.nodeId === id)).length
    return (
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13.5px] font-medium">{slot.label}</span>
          <span className="text-[12px] text-black/40">
            {multi ? '可多选，选几个就出几个结果' : '单选'}
          </span>
          {pickedCount > 0 && (
            <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
              已选 {pickedCount} 个 · 出 {pickedCount} 个结果
            </span>
          )}
        </div>
        {slot.description && (
          <p className="mb-1.5 text-[12px] leading-relaxed text-black/40">{slot.description}</p>
        )}
        {/*
          * 方向/风格选项：**不用彩色渐变块**。
          * 之前是「紫色渐变 + 首字」的封面格，满屏紫色色块很「AI 海报」，
          * 而且首字没有信息量（认不出方向，还得读小字）。
          * 现在改成偏设置项的勾选卡：左侧勾选圈 + 方向名，选中只加主色描边与浅底，
          * 信息全在文字上，和工具箱列表页的克制风格对齐。
          */}
        <div className={`grid gap-2 ${multi ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}>
          {visibleOptions.map((o) => {
            const on = selected.includes(o.nodeId)
            return (
              <button
                key={o.nodeId}
                type="button"
                aria-pressed={on}
                title={o.label}
                onClick={() => {
                  if (!multi) {
                    // 单选：再点一次可取消，避免选错了没法回到空值
                    onChange(on ? [] : [o.nodeId])
                    return
                  }
                  onChange(on ? selected.filter((x) => x !== o.nodeId) : [...selected, o.nodeId])
                }}
                className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on
                    ? 'border-accent/60 bg-accent-soft/45'
                    : 'border-black/[0.09] bg-white hover:border-black/25 hover:bg-black/[0.015]'
                }`}
              >
                <span
                  className={`mt-[1px] grid size-4 shrink-0 place-items-center border transition-colors ${
                    multi ? 'rounded-[4px]' : 'rounded-full'
                  } ${on ? 'border-accent bg-accent text-white' : 'border-black/25 bg-white'}`}
                >
                  {on && <Icons.CheckOutlined className="text-[9px]" />}
                </span>
                <span className="min-w-0 flex-1">
                  {/* 方向名可能较长（如「OZON · 辅图卖点信息图」）：最多两行 + 悬停看全名，
                      不用单行省略，否则用户分不清相近的方向 */}
                  <span className={`line-clamp-2 block text-[12.5px] leading-snug ${on ? 'font-medium' : ''}`}>
                    {o.label}
                  </span>
                  {o.aiPolish && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded border border-black/[0.07] bg-black/[0.03] px-1.5 py-[1px] text-[10px] text-black/45">
                      <Icons.RobotOutlined className="text-[9px]" /> 智能润色
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // 2026-10-25：这里原本是内联的一大段（价格三列 + 免费额度 + 收起态 + 设为默认）。
  // 电商 Agent 面板当时又手写了一个 <Select>，把上面这些全丢了 ——
  // 用户指出「每加一个工具就重写一套，然后再补一遍」。
  // 现在两处共用 ModelPicker 这一份实现，新增工具也一律调它。
  if (slot.type === 'model') {
    const curVideoModel = slot.modelType === 'VIDEO' ? models.find((m) => m.id === (typeof value === 'string' ? value : '')) : undefined
    // 生成方式选择器：模型声明 ≥2 种方式才出现（单形态工具不渲染）。
    // 放在模型选择正下方 —— 用户操作顺序就是「第一步选模型，第二步选方式」。
    const videoModes = curVideoModel
      ? sortVideoModes(getVideoCapabilities(curVideoModel).modes.filter((m) => !!VIDEO_MODE_LABELS[m]))
      : []
    const curMedia = curVideoModel ? resolveVideoMediaSlots(getVideoCapabilities(curVideoModel)) : null
    return (
      <div data-guide={guideAnchor}>
        {labelRow}
        <ModelPicker
          models={models}
          value={typeof value === 'string' ? value : ''}
          onChange={(id) => onChange(id)}
          modelType={slot.modelType ?? 'IMAGE'}
          required={slot.required}
          persistKey={modelPersistKey}
          message={message}
        />
        {videoModes.length >= 2 && onVideoModeChange && (
          <div className="mt-2">
            <div className="mb-1 text-[12px] text-black/40">生成方式</div>
            <div className="flex flex-wrap gap-1.5">
              {videoModes.map((mode) => {
                const on = (videoMode ?? videoModes[0]) === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onVideoModeChange(mode)}
                    className="composer-option" data-active={on ? 'true' : undefined}
                  >
                    {VIDEO_MODE_LABELS[mode] ?? mode}
                  </button>
                )
              })}
            </div>
            {videoMode === 'multiReference' && curMedia && (
              <div className="mt-1 text-[11px] text-black/35">
                该模型支持 {describeVideoMediaSlots(curMedia)}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (slot.type === 'ratio') {
    const v = (typeof value === 'object' && value !== null ? value : {}) as { ratio?: string; tier?: string }
    const isVideo = (slot.targets[0]?.port ?? '') === 'aspectRatio'
    // 规格必须跟随模型：没选模型时不给选规格。
    // 否则用户先挑好比例/档位、后端却按兜底模型跑，规格对不上还得重跑一次。
    // 仅当该工具存在 model 槽位时才拦截（纯规格工具除外）。
    if (needsModelFirst && !selectedModelId) {
      return (
        <div data-guide={guideAnchor}>
          {labelRow}
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-black/12 bg-black/[0.02] px-3 py-2.5 text-[12px] text-black/45">
            <Icons.RobotOutlined className="text-accent/60" />
            请先在上方选择模型，再设置图片规格
          </div>
        </div>
      )
    }
    // 生图规格跟随所选模型：读 model.metadata.sizes（"1:1@2K" 数组，与画布 image-generate 节点同一数据源），
    // 只列出该模型勾选过的比例×档位，避免传了不支持的尺寸被上游报错
    const curModelId = selectedModelId
    const model = models.find((m) => m.id === curModelId)
    const imageCap = getImageCapabilities(model)
    const modelRatios = imageCap.ratios
    // 视频模型：能力来自 metadata.video.constraints（与图片 metadata.sizes 同思路）。
    // 未声明比例 → 用兜底全量；声明了 → 只给该模型支持的。
    const videoCap = isVideo ? getVideoCapabilities(model) : null
    const videoRatios = videoCap && videoCap.ratios.length > 0 ? videoCap.ratios : DEFAULT_VIDEO_RATIOS
    // 无模型/模型未配 sizes → 回落常用比例；模型声明 sizes 后绝不回落到全局档位。
    const ratioOptions = isVideo
      ? videoRatios
      : (imageCap.declared ? modelRatios : [...ASPECT_RATIOS].slice(0, 8))
    const curRatio = ratioOptions.includes(v.ratio ?? (isVideo ? '16:9' : '1:1')) ? v.ratio : undefined
    const tierOptions = !isVideo
      ? (imageCap.declared ? (imageCap.tiersByRatio[curRatio ?? ratioOptions[0] ?? ''] ?? []) : [...RES_TIERS])
      : []
    const curTier = tierOptions.includes(v.tier ?? '1K') ? v.tier : undefined
    // 视频：分辨率 + 时长也跟随模型能力（模型没声明则用兜底）
    // 档位标签统一到 canonical（768P / 1080P / 2K）——上游/配置可能写 768p，
    // 直接展示会与兜底集合对不上，出现「模型声明了档位却一个都不显示」。
    const videoResOptions = isVideo
      ? (videoCap && videoCap.resolutions.length > 0
          ? videoCap.resolutions.map((r) => normalizeVideoResolution(r))
          : [...DEFAULT_VIDEO_RESOLUTIONS])
      : []
    const videoDurOptions = isVideo ? resolveVideoDurations(videoCap!) : []
    const vv = v as { ratio?: string; resolution?: string; duration?: number }
    const curRes = videoResOptions.includes(normalizeVideoResolution(vv.resolution)) ? normalizeVideoResolution(vv.resolution) : (videoResOptions[0] ?? undefined)
    const curDur = videoDurOptions.includes(vv.duration ?? -1) ? vv.duration : (videoDurOptions[0] ?? undefined)
    return (
      <div data-guide={guideAnchor}>
        {labelRow}
        {isVideo ? (
          // 视频：比例 / 分辨率 / 时长三行，全部只列「当前模型支持」的项
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {ratioOptions.map((r) => {
                const on = (curRatio ?? '16:9') === r
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => onChange({ ...v, ratio: r, resolution: curRes, duration: curDur })}
                    className="composer-option" data-active={on ? 'true' : undefined}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
            {videoResOptions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] text-black/40">清晰度</span>
                {videoResOptions.map((res) => {
                  const on = curRes === res
                  return (
                    <button
                      key={res}
                      type="button"
                      onClick={() => onChange({ ...v, ratio: curRatio, resolution: res, duration: curDur })}
                      className="composer-option" data-active={on ? 'true' : undefined}
                    >
                      {res}
                    </button>
                  )
                })}
              </div>
            )}
            {videoDurOptions.length > 0 && videoCap?.durationSelectable !== false && (
              (() => {
                // 连续区间（如 4–30 共 27 档）用滑块，避免几十个按钮把面板撑爆；
                // 离散档（5/10/15/30）仍是按钮 —— 拖动条在稀疏档位上更难点准。
                const first = videoDurOptions[0]
                const last = videoDurOptions[videoDurOptions.length - 1]
                const isContinuous = isContinuousDurationRange(videoDurOptions, videoCap?.fixedDuration)
                const active = curDur ?? first
                if (isContinuous) {
                  return (
                    <DurationSlider
                      min={first}
                      max={last}
                      value={active}
                      onChange={(sec) => onChange({ ...v, ratio: curRatio, resolution: curRes, duration: sec })}
                    />
                  )
                }
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] text-black/40">时长</span>
                    {videoDurOptions.map((sec) => {
                      const on = curDur === sec
                      return (
                        <button
                          key={sec}
                          type="button"
                          onClick={() => onChange({ ...v, ratio: curRatio, resolution: curRes, duration: sec })}
                          className="composer-option" data-active={on ? 'true' : undefined}
                        >
                          {sec}s
                        </button>
                      )
                    })}
                  </div>
                )
              })()
            )}
          </div>
        ) : (
          // 比例可能多达十几个（模型支持的规格），Segmented 单行会横向溢出到面板外。
          // 改成两行：比例用可换行的标签按钮组（自动折行），档位单独一行。
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {ratioOptions.map((r) => {
                const on = (curRatio ?? '1:1') === r
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      // 切比例自动带出该比例第一个可用档位（模型配置时）
                      const firstTier = findImageSize(imageCap, r)?.tier
                      onChange({ ratio: r, tier: firstTier ?? v.tier ?? '1K' })
                    }}
                    className="composer-option" data-active={on ? 'true' : undefined}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tierOptions.map((t) => {
                const on = (curTier ?? '1K') === t
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onChange({ ...v, tier: t })}
                    className="composer-option" data-active={on ? 'true' : undefined}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {imageCap.declared && (
          <div className="mt-1.5 text-[12px] text-black/40">已按 {model?.name} 支持的规格过滤</div>
        )}
        {isVideo && (videoCap?.ratios.length || videoCap?.resolutions.length || videoCap?.durations.length) ? (
          <div className="mt-1.5 text-[12px] text-black/40">已按 {model?.name} 支持的比例 / 清晰度 / 时长过滤</div>
        ) : null}
      </div>
    )
  }

  if (slot.type === 'number') {
    return (
      <div>
        {labelRow}
        <Segmented
          value={typeof value === 'number' ? value : 1}
          onChange={(n) => onChange(n)}
          options={((slot.multipliers ?? [1, 2, 4]) as number[]).map((n) => ({ value: n, label: `×${n}` }))}
        />
      </div>
    )
  }

  return null
}


// ===== 左列成果行（单行缩略图 + 类型图标 + 风格名；hover 可移除） =====
/** 运行中占位的秒级计时（仅在需要时每秒 tick，避免整页重渲染） */
export function useElapsed(from: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !from) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active, from])
  if (!from) return 0
  return Math.max(0, Math.floor((now - from) / 1000))
}

export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m} 分 ${s} 秒`
}

  /**
   * 服务端任务（CanvasRun）在前端的形状（认领用）。
   * results 里每条产出对应一次「份」的 run。
   */

export function ResultRow({ item, active, selected, onToggleSelect, onClick, onImgError, onImgLoad, onRetry, onRemove, onZoom, onRespeed }: {
  item: ResultItem
  active: boolean
  /** 是否被勾选（批量操作）。运行中的占位不可选 */
  selected: boolean
  onToggleSelect: () => void
  onClick: () => void
  onImgError: () => void
  /** 图片加载成功：重置过期/重试计数 */
  onImgLoad: () => void
  /** 图片加载失败后手动重试（换 cache-busting 参数重新加载） */
  onRetry: () => void
  onRemove: () => void
  /**
   * 放大查看（可选）。
   * 为什么不复用 onClick：成果卡片的 onClick 已经被「送到工作台编辑」占用，
   * 再挂一个放大语义会冲突 —— 所以用 hover 出来的独立按钮 + 独立回调。
   */
  onZoom?: () => void
  /** GIF 调速（只重新合成，不重新生图） */
  onRespeed?: () => void
}) {
  const { message } = App.useApp()
  const kindIcon = kindIconOf(item.kind)
  const isGif = item.kind === 'image' && isGifUrl(item.url)
  // 生成失败（后端真失败）与「图挂了」（链接过期）是两件事，分开渲染
  const genFailed = item.status === 'error'
  const imgExpired = item.status === 'done' && item.imageState === 'expired'
  const isRunning = item.status === 'running'
  const selectable = item.status === 'done' && !!item.url
  // 三段式：准备中（节点已开跑）→ 等待派发（闸门排队）→ 生成中（已发出等上游）→ 完成/失败
  const phase = item.phase
  const elapsed = useElapsed(item.phaseSince, isRunning)
  const handleCardClick = () => {
    // GIF 进工作台只会显示第一帧，点击应该直接看动图
    if (isGif && onZoom) { onZoom(); return }
    onClick()
  }
  const download = async () => {
    if (!item.url) return
    const { ok, failed } = await downloadResults([{
      url: item.url,
      kind: item.kind,
      name: item.styleLabel || (isGif ? '循环动图' : '成果'),
    }])
    if (ok > 0) message.success(isGif ? '已开始下载 GIF' : '已开始下载')
    else if (failed > 0) message.error('下载失败（链接可能已过期）')
  }
  const copy = async () => {
    if (!item.url) return
    try {
      const res = await copyMediaToClipboard(item.url, item.kind)
      message.success(res.message)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '复制失败')
    }
  }

  return (
    <div
      // 框选批量选择需要：命中判定读 data-result-row（哪些元素可被框）
      // + data-result-url（框到后勾选哪个 url）。两者是滑动选择的契约，勿删。
      data-result-row
      data-result-url={item.url || undefined}
      // draggable：把成果图拖到操作面板上传区（当输入）或工作台（打开编辑）。
      // 用自定义 MIME 承载载荷，落点据此区分「站内拖图」与「本地拖文件」。
      // 运行中的占位 / 失败项不可拖（没有可用的 url）。
      draggable={selectable}
      onDragStart={(e) => {
        if (!selectable) return
        e.dataTransfer.setData(RESULT_DRAG_MIME, JSON.stringify({ url: item.url, kind: item.kind, label: item.styleLabel }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className={`group flex cursor-pointer items-center gap-2 rounded-xl border p-1.5 transition ${selected ? 'border-accent bg-accent-soft/70' : active ? 'border-accent bg-accent-soft/60' : 'border-black/6 bg-white hover:border-accent-ring'}`}
      onClick={handleCardClick}
    >
      {/* 勾选框：只在可下载的成果上出现，运行中/失败项不占位 */}
      {selectable && (
        <button
          type="button"
          aria-label={selected ? '取消选择' : '选择'}
          onClick={(e) => { e.stopPropagation(); onToggleSelect() }}
          className={`grid size-4 shrink-0 place-items-center rounded border transition ${
            selected ? 'border-accent bg-accent text-white' : 'border-black/20 bg-white hover:border-accent'
          }`}
        >
          {selected && <Icons.CheckOutlined className="text-[9px]" />}
        </button>
      )}
      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-black/[0.04]">
        {isRunning ? (
          // 生成中：网格渐显占位（紫调细网格 + 中心 logo），出图后自然过渡到真图
          <div className="relative size-full">
            <GridReveal className="size-full" cell={8} />
            <div className="absolute inset-0 grid place-items-center"><AnimatedLogo size={26} /></div>
          </div>
        ) : genFailed ? (
          // 后端真失败：显示失败图标
          <div className="grid size-full place-items-center bg-gradient-to-br from-red-50 to-red-100/50">
            <Icons.ThunderboltFilled className="text-lg text-red-300" />
          </div>
        ) : imgExpired ? (
          // 生成成功但图挂了（台账 Q-703）：以前只有一个看不出含义的眼睛图标。
          // 现在用与「生成中」同一套品牌占位，但**降透明 + 去饱和**做静态处理 ——
          // 满彩动画会被读成「还在跑」，而这块区域确实是有成果的，只是外链过期。
          // 真正的状态说明交给卡片下方那行「已生成 · 链接已过期 + 重试」。
          <div className="relative size-full bg-black/[0.03]">
            <GridReveal className="size-full" cell={8} />
            <div className="absolute inset-0 grid place-items-center">
              <AnimatedLogo size={26} className="opacity-25 grayscale" />
            </div>
          </div>
        ) : item.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            // cache-busting：手动重试时换参数，绕过浏览器对「失败响应」的缓存
            // 同源代理地址：与工作台 fetch 共用同一份浏览器缓存（见 displayUrl 注释）
            src={(() => {
              const base = displayUrl(item.url)
              return item.retryCount ? `${base}${base.includes('?') ? '&' : '?'}_r=${item.retryCount}` : base
            })()}
            alt=""
            className="size-full object-cover"
            onError={onImgError}
            onLoad={onImgLoad}
          />
        ) : item.kind === 'video' ? (
          <video src={item.url} className="size-full object-cover" preload="metadata" muted />
        ) : (
          <div className="grid size-full place-items-center bg-gradient-to-br from-accent/15 to-accent/5">
            <SoundOutlined className="text-lg text-accent/50" />
          </div>
        )}
        {item.status === 'running' && (
          <div className="absolute inset-0 grid place-items-center bg-white/60"><AnimatedLogo size={26} /></div>
        )}
        {/* 悬停出「放大」：卡片 onClick 已用于「送到工作台」，放大走独立按钮避免语义冲突。
            触屏没有 hover，所以 max-lg 常显（与选择框同一处理）。 */}
        {onZoom && selectable && item.kind === 'image' && (
          <button
            type="button"
            aria-label="放大查看"
            title="放大查看"
            onClick={(e) => { e.stopPropagation(); onZoom() }}
            className="absolute right-0.5 bottom-0.5 grid size-5 place-items-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 max-lg:opacity-100"
          >
            <Icons.ZoomInOutlined className="text-[10px]" />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[12px] text-black/65">
          {kindIcon}
          <span className="truncate">{item.styleLabel || (isGif ? 'GIF 动图' : mediaLabel(item.kind))}</span>
        </div>
        {isRunning && (
          <div className="space-y-0.5 text-[11px] text-accent">
            {/* 标注（「第5格」「主图 2/3」）+ 已等待时长 */}
            <div className="flex items-center gap-1">
              <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              <span className="truncate">
                {item.queueNote ? `${item.queueNote}` : ''}
                {elapsed > 0 ? `${item.queueNote ? ' · ' : ''}${formatElapsed(elapsed)}` : ''}
              </span>
            </div>
            {/* 阶段流程条：动态段数（有 LLM 才有「优化提示词」），
                比单句「准备中」更能说明「现在走到哪一步」。 */}
            <StageFlow stages={buildImageStages({
              // 工具执行期的 LLM 阶段由 nodeStart/nodeOutput 实时回填；
              // Agent 的占位是在 LLM 出完 tool_call 之后才建的，仍按 done 展示。
              llmStage: item.llmStage ?? (item.hasLlmStage ? 'done' : undefined),
              llmStageLabel: item.llmStageLabel,
              phase,
              status: 'running',
            })} />
          </div>
        )}
        {/* 生成失败：带上原因，让用户知道「该做什么」（换素材 / 重传 / 直接重试） */}
        {genFailed && (
          <div className="space-y-0.5">
            <div className="text-[11px] text-red-400">生成失败</div>
            {item.failReason && (
              // 悬停看全文（长原因在窄卡片里会被截断），点击卡片仍可打开大图预览
              <div
                className="line-clamp-2 text-[10.5px] leading-snug text-black/45"
                title={item.failReason}
                onClick={(e) => e.stopPropagation()}
              >
                {item.failReason}
              </div>
            )}
          </div>
        )}
        {/* 生成成功、只是图显示不出来：明确告诉用户「已生成成功」，别误以为是失败 */}
        {imgExpired && (
          <div className="flex items-center gap-1.5 text-[11px] text-black/40">
            <span>已生成 · 链接已过期</span>
            <button
              type="button"
              className="rounded px-1 text-accent transition hover:bg-accent-soft"
              onClick={(e) => { e.stopPropagation(); onRetry() }}
            >
              重试
            </button>
          </div>
        )}
        {/* 完成态元信息：模型 / 耗时 / 扣费。
            生成中显示得很详细、一完成全没了 —— 用户看不出「用什么模型生成的、花了多久、扣了多少」。
            这里把执行期带出来的 meta 补回卡片。 */}
        {!isRunning && !genFailed && (item.modelName || item.durationMs != null || (item.costPoints ?? 0) > 0 || (item.costBeans ?? 0) > 0) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-black/40">
            {item.modelName && <span className="truncate" title={item.modelName}>{item.modelName}</span>}
            {item.durationMs != null && item.durationMs > 0 && (
              <span>{item.durationMs < 1000 ? `${item.durationMs}ms` : `${(item.durationMs / 1000).toFixed(1)}s`}</span>
            )}
            {(item.costBeans ?? 0) > 0 ? (
              <span className="text-amber-600">{item.costBeans} 豆</span>
            ) : (item.costPoints ?? 0) > 0 ? (
              <span>{item.costPoints} 积分</span>
            ) : null}
          </div>
        )}
      </div>
      {/* 单条下载/复制：成果多了以后批量操作不顺手，常用动作放在卡片上 */}
      {selectable && (
        <span
          className="flex shrink-0 items-center gap-0.5 max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            title={isGif ? '下载 GIF' : '下载'}
            aria-label={isGif ? '下载 GIF' : '下载'}
            onClick={() => void download()}
            className="grid size-6 place-items-center rounded-md text-black/40 transition hover:bg-black/5 hover:text-accent"
          >
            <Icons.DownloadOutlined className="text-[12px]" />
          </button>
          {item.kind === 'image' && (
            <button
              type="button"
              title={isGif ? '复制 GIF（浏览器不支持时复制动图链接）' : '复制图片'}
              aria-label="复制"
              onClick={() => void copy()}
              className="grid size-6 place-items-center rounded-md text-black/40 transition hover:bg-black/5 hover:text-accent"
            >
              <Icons.CopyOutlined className="text-[12px]" />
            </button>
          )}
          {isGif && onRespeed && (
            <button
              type="button"
              title="调整 GIF 速度"
              aria-label="调整 GIF 速度"
              onClick={() => onRespeed()}
              className="grid size-6 place-items-center rounded-md text-black/40 transition hover:bg-black/5 hover:text-accent"
            >
              <Icons.SlidersOutlined className="text-[12px]" />
            </button>
          )}
        </span>
      )}
      {/* 删除：就地确认（点一下展开确认/取消），避免误删一屏成果 */}
      <span
        className="shrink-0 max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <ConfirmButton variant="ghost" title="移除" onConfirm={onRemove} />
      </span>
    </div>
  )
}
