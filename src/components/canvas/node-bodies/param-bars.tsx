'use client'

import { useEffect } from 'react'
import { Button, Select, InputNumber, Input, Modal } from 'antd'
import { HighlightOutlined } from '@ant-design/icons'
import { findImageSize, getImageCapabilities } from '@/lib/image-sizes'
import { DEFAULT_VIDEO_RATIOS, DEFAULT_VIDEO_RESOLUTIONS, getVideoCapabilities, normalizeVideoResolution, resolveVideoDurations } from '@/lib/video-capabilities'
import { normalizeGrid } from '@/lib/nine-grid-loop'
import { NodeBodyCtx } from './types'
import { ModelSelect, CostChip, RunButton } from './shared'

// 音频上传节点参数条：说明（音频从卡身录音/上传，运行后透传给下游）
export function AudioUploadParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">语音</span>
      <span className="flex-1 truncate text-xs text-text-muted">{ctx.node.inputs.audio ? '已上传音频，连到下游使用' : '录音或上传音频，连到下游(如语音识别)'}</span>
      <RunButton ctx={ctx} />
    </div>
  )
}

// 九宫格转 GIF：纯本地处理，不选模型、不扣积分；参数在下方填写面板里调
export function Grid9GifParamBar(ctx: NodeBodyCtx) {
  const delay = Number(ctx.node.inputs.delayMs) || 150
  const grid = normalizeGrid(ctx.node.inputs.grid)
  const rawMode = String(ctx.node.inputs.mode ?? 'normal').trim().toLowerCase()
  const pingpong = ['pingpong', 'ping-pong', '往返乒乓', '乒乓', '往返'].includes(rawMode)
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">动图</span>
      <span className="flex-1 truncate text-xs text-text-muted">
        {grid}×{grid} · {delay}ms · {pingpong ? '往返乒乓' : '正序循环'} · 不扣积分
      </span>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function LLMParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">LLM</span>
      <ModelSelect ctx={ctx} wantTypes={['TEXT', 'VISION']} />
      <CostChip ctx={ctx} />
      <InputNumber
        size="small"
        variant="borderless"
        className="w-14 shrink-0"
        min={0}
        max={2}
        step={0.1}
        value={typeof ctx.node.inputs.temperature === 'number' ? ctx.node.inputs.temperature : 0.7}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'temperature', v ?? 0.7)}
        title="温度"
      />
      <RunButton ctx={ctx} />
    </div>
  )
}

export function ImageGenParamBar(ctx: NodeBodyCtx) {
  const modelId = ctx.node.inputs.model as string | undefined
  const model = ctx.modelOptions.find((m) => m.id === modelId)
  const imageCap = getImageCapabilities(model)
  const decoded = imageCap.sizes
  const ratios = [...new Set(decoded.map((d) => d.ratio))]
  const curW = Number(ctx.node.inputs.width) || 0
  const curH = Number(ctx.node.inputs.height) || 0
  // 先精确匹配当前宽高对应的预设条目
  const matched = decoded.find((d) => d.width === curW && d.height === curH)
  // 如果匹配不到，视为未选（显示 placeholder，杜绝「显示 1K 实际按预设外尺寸调用」的不一致）
  const selRatio = matched?.ratio
  const selTier = matched?.tier
  const setWH = (w: number, h: number) => {
    ctx.onUpdateInput(ctx.node.id, 'width', w)
    ctx.onUpdateInput(ctx.node.id, 'height', h)
  }
  useEffect(() => {
    if (!imageCap.declared || decoded.length === 0) return
    const exact = decoded.find((d) => d.width === curW && d.height === curH)
    if (!exact) {
      const first = decoded[0]
      setWH(first.width, first.height)
    }
    // setWH 是当前节点输入的写入器；curW/curH 已覆盖其状态来源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, curW, curH, imageCap.declared, decoded.length])
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">生图</span>
      <ModelSelect
        ctx={ctx}
        wantTypes={['IMAGE']}
        onAfterChange={(id) => {
          const next = ctx.modelOptions.find((m) => m.id === id)
          const first = getImageCapabilities(next).sizes[0]
          if (first) setWH(first.width, first.height)
        }}
      />
      {ratios.length > 0 && (
        <>
          <Select
            size="small"
            variant="borderless"
            className="w-[76px] shrink-0 text-xs"
            value={selRatio}
            onChange={(r) => { const f = findImageSize(imageCap, r); if (f) setWH(f.width, f.height) }}
            options={ratios.map((r) => ({ value: r, label: r }))}
            placeholder="比例"
            title={selRatio ? undefined : `当前 ${curW}x${curH} 不在预设内，请选择`}
          />
          <Select
            size="small"
            variant="borderless"
            className="w-[84px] shrink-0 text-xs"
            value={selTier}
            onChange={(t) => { const hit = decoded.find((d) => d.ratio === selRatio && d.tier === t); if (hit) setWH(hit.width, hit.height) }}
            options={selRatio ? decoded.filter((d) => d.ratio === selRatio).map((d) => ({ value: d.tier, label: d.tier })) : []}
            placeholder="档位"
            disabled={!selRatio}
          />
        </>
      )}
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

export function VideoGenParamBar(ctx: NodeBodyCtx) {
  const modelId = ctx.node.inputs.model as string | undefined
  const model = ctx.modelOptions.find((m) => m.id === modelId)
  const cap = getVideoCapabilities(model)
  const ratios = cap.ratios.length > 0 ? cap.ratios : DEFAULT_VIDEO_RATIOS
  const resolutions = (cap.resolutions.length > 0 ? cap.resolutions : DEFAULT_VIDEO_RESOLUTIONS)
    .map((r) => normalizeVideoResolution(r))
  const durations = resolveVideoDurations(cap)
  const curRatio = typeof ctx.node.inputs.aspectRatio === 'string' && ratios.includes(ctx.node.inputs.aspectRatio)
    ? ctx.node.inputs.aspectRatio
    : undefined
  const curResolution = typeof ctx.node.inputs.resolution === 'string' && resolutions.includes(normalizeVideoResolution(ctx.node.inputs.resolution))
    ? normalizeVideoResolution(ctx.node.inputs.resolution)
    : undefined
  const curDuration = typeof ctx.node.inputs.duration === 'number' && durations.includes(ctx.node.inputs.duration)
    ? ctx.node.inputs.duration
    : undefined

  useEffect(() => {
    if (!modelId) return
    const ratio = curRatio ?? ratios[0]
    const resolution = curResolution ?? resolutions[0]
    const duration = curDuration ?? durations[0]
    if (ratio !== ctx.node.inputs.aspectRatio) ctx.onUpdateInput(ctx.node.id, 'aspectRatio', ratio)
    if (resolution !== ctx.node.inputs.resolution) ctx.onUpdateInput(ctx.node.id, 'resolution', resolution)
    if (duration !== ctx.node.inputs.duration) ctx.onUpdateInput(ctx.node.id, 'duration', duration)
    // 输入值变化会再次进入本 effect，条件不成立后自然停止
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, curRatio, curResolution, curDuration, ratios.join(','), resolutions.join(','), durations.join(',')])

  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">视频</span>
      <ModelSelect
        ctx={ctx}
        wantTypes={['VIDEO']}
        onAfterChange={(id) => {
          const next = ctx.modelOptions.find((m) => m.id === id)
          const nextCap = getVideoCapabilities(next)
          const nextRatios = nextCap.ratios.length > 0 ? nextCap.ratios : DEFAULT_VIDEO_RATIOS
          const nextRes = (nextCap.resolutions.length > 0 ? nextCap.resolutions : DEFAULT_VIDEO_RESOLUTIONS)
            .map((r) => normalizeVideoResolution(r))
          const nextDur = resolveVideoDurations(nextCap)
          ctx.onUpdateInput(ctx.node.id, 'aspectRatio', nextRatios[0])
          ctx.onUpdateInput(ctx.node.id, 'resolution', nextRes[0])
          ctx.onUpdateInput(ctx.node.id, 'duration', nextDur[0])
        }}
      />
      <Select
        size="small"
        variant="borderless"
        className="w-[76px] shrink-0 text-xs"
        disabled={!modelId}
        value={curRatio}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'aspectRatio', v)}
        options={ratios.map((r) => ({ value: r, label: r }))}
        placeholder="画幅"
      />
      <Select
        size="small"
        variant="borderless"
        className="w-[82px] shrink-0 text-xs"
        disabled={!modelId}
        value={curResolution}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'resolution', v)}
        options={resolutions.map((r) => ({ value: r, label: r }))}
        placeholder="清晰度"
      />
      <Select
        size="small"
        variant="borderless"
        className="w-[70px] shrink-0 text-xs"
        disabled={!modelId}
        value={curDuration}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'duration', v)}
        options={durations.map((d) => ({ value: d, label: `${d}s` }))}
        placeholder="时长"
      />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

export function AudioGenParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">音频</span>
      <ModelSelect ctx={ctx} wantTypes={['AUDIO']} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

export function MusicGenParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">音乐</span>
      <ModelSelect ctx={ctx} wantTypes={['AUDIO']} wantKinds={['music']} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

export function TtsGenParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">配音</span>
      <ModelSelect ctx={ctx} wantTypes={['AUDIO']} wantKinds={['tts']} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

// 音效生成参数条：选音效模型 + 时长
export function SfxGenParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">音效</span>
      <ModelSelect ctx={ctx} wantTypes={['AUDIO']} wantKinds={['sfx']} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

// 人声分离参数条：选分离模型（计费按秒，走积分按次折算）
export function VoiceIsolateParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">分离</span>
      <ModelSelect ctx={ctx} wantTypes={['AUDIO']} wantKinds={['isolate']} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

// 感知节点（语音识别 ASR / 文字识别 OCR）参数条：选识别模型
export function PerceptionParamBar(ctx: NodeBodyCtx) {
  const isAsr = ctx.node.type === 'transcribe'
  const want = isAsr ? ['AUDIO'] : ['VISION']
  const kinds = isAsr ? ['asr'] : ['ocr']
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">{isAsr ? '语音' : 'OCR'}</span>
      <ModelSelect ctx={ctx} wantTypes={want} wantKinds={kinds} />
      <CostChip ctx={ctx} />
      <RunButton ctx={ctx} />
    </div>
  )
}

// ========== 人脸涂鸦：浮动参数条（对应 ImageGenParamBar 的位置）============
//
// 参照「图像生成」节点的范式：选中节点 → 节点上方浮一条液态玻璃参数条，
// 下方浮填写面板。涂鸦原来是把 7 个参数全塞进一个全屏 Modal，
// 导致「改参数要先开弹窗、关掉弹窗就回到画布」，与站内其他节点交互不一致。
// 现在把高频参数提到参数条，低频/整块操作留在工作台。
export function FaceDoodleParamBar(ctx: NodeBodyCtx) {
  const num = (key: string, fallback: number) => {
    const v = Number(ctx.node.inputs[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const setNum = (key: string, v: number | null) => {
    if (v != null) ctx.onUpdateInput(ctx.node.id, key, v)
  }
  return (
    <div className="flex flex-1 items-center justify-between gap-1.5 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">涂鸦</span>
      {/* 密度：涂鸦线条数，直接决定遮挡感 */}
      <Select
        size="small"
        variant="borderless"
        className="w-[86px] shrink-0 text-xs"
        value={num('density', 42)}
        onChange={(v) => setNum('density', v)}
        options={[15, 30, 42, 60, 90].map((d) => ({ value: d, label: `密度 ${d}` }))}
        title="涂鸦线条数（越大越密）"
      />
      {/* 粗细：按脸宽自适应，这里的值是基准 px */}
      <Select
        size="small"
        variant="borderless"
        className="w-[86px] shrink-0 text-xs"
        value={num('strokeWidth', 2.2)}
        onChange={(v) => setNum('strokeWidth', v)}
        options={[1.0, 1.5, 2.2, 3.5, 5.0].map((s) => ({ value: s, label: `粗细 ${s}` }))}
        title="基准笔画粗细（按脸宽自适应缩放）"
      />
      {/* 遮挡范围：1.3 最松、0.9 最贴脸 */}
      <Select
        size="small"
        variant="borderless"
        className="w-[76px] shrink-0 text-xs"
        value={num('coverage', 1.1)}
        onChange={(v) => setNum('coverage', v)}
        options={[
          { value: 0.9, label: '贴合' },
          { value: 1.1, label: '遮挡' },
          { value: 1.3, label: '放宽' },
        ]}
        title="涂鸦范围相对人脸的缩放"
      />
      {/* 灵敏度：检测阈值，改完需点「重新扫描」才生效（在下方面板里点） */}
      <Select
        size="small"
        variant="borderless"
        className="w-[86px] shrink-0 text-xs"
        value={num('threshold', 0.18)}
        onChange={(v) => setNum('threshold', v)}
        options={[
          { value: 0.08, label: '灵敏' },
          { value: 0.18, label: '均衡' },
          { value: 0.3, label: '保守' },
        ]}
        title="人脸检测灵敏度（改完需在工作台点重新扫描）"
      />
      <Button
        size="small"
        icon={<HighlightOutlined />}
        onClick={(e) => { e.stopPropagation(); ctx.onOpenWorkbench?.(ctx.node.id) }}
        onPointerDown={ctx.stopPropagation}
        className="shrink-0"
      >
        工作台
      </Button>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function JsonParserParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">JSON</span>
      <span className="flex-1 truncate text-xs text-text-muted">{ctx.node.inputs.field ? `提取字段: ${String(ctx.node.inputs.field)}` : '自动识别数组结构'}</span>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function FieldExtractorParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">字段</span>
      <span className="flex-1 truncate text-xs text-text-muted">提取字段: {String(ctx.node.inputs.field ?? 'prompt')}</span>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function BatchPromptParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">批量</span>
      <div className="w-28 shrink-0" onPointerDown={ctx.stopPropagation}>
        <Input
          size="small"
          variant="borderless"
          className="text-xs"
          value={String(ctx.node.inputs.field ?? 'prompt')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'field', e.target.value)}
          placeholder="提取字段"
        />
      </div>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function ConditionCheckParamBar(ctx: NodeBodyCtx) {
  const OPS = ['equals', 'contains', 'greaterThan', 'lessThan'].map((v) => ({ value: v, label: v }))
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">条件</span>
      <div className="w-28 shrink-0" onPointerDown={ctx.stopPropagation}>
        <Select
          size="small"
          variant="borderless"
          className="w-full text-xs"
          value={ctx.node.inputs.operator ? String(ctx.node.inputs.operator) : undefined}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'operator', v)}
          options={OPS}
          placeholder="运算符"
        />
      </div>
      <div className="w-24 shrink-0" onPointerDown={ctx.stopPropagation}>
        <Input
          size="small"
          variant="borderless"
          className="text-xs"
          value={String(ctx.node.inputs.compareTo ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'compareTo', e.target.value)}
          placeholder="比较值"
        />
      </div>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function NumberCalcParamBar(ctx: NodeBodyCtx) {
  const OPS = [{ value: 'add', label: '+' }, { value: 'subtract', label: '−' }, { value: 'multiply', label: '×' }, { value: 'divide', label: '÷' }]
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">计算</span>
      <div className="w-16 shrink-0" onPointerDown={ctx.stopPropagation}>
        <Select
          size="small"
          variant="borderless"
          className="w-full text-xs"
          value={ctx.node.inputs.operator ? String(ctx.node.inputs.operator) : 'add'}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'operator', v)}
          options={OPS}
        />
      </div>
      <RunButton ctx={ctx} />
    </div>
  )
}

export function TextConcatParamBar(ctx: NodeBodyCtx) {
  return (
    <div className="flex flex-1 items-center justify-between gap-2 px-3 py-1.5" onPointerDown={ctx.stopPropagation}>
      <span className="shrink-0 text-[10px] font-medium text-accent">拼接</span>
      <div className="w-24 shrink-0" onPointerDown={ctx.stopPropagation}>
        <Input
          size="small"
          variant="borderless"
          className="text-xs"
          value={String(ctx.node.inputs.separator ?? '\n')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'separator', e.target.value)}
          placeholder="分隔符"
        />
      </div>
      <RunButton ctx={ctx} />
    </div>
  )
}
