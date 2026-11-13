'use client'

import { Button, InputNumber, Input, Select, Tooltip } from 'antd'
import { PromptEditor, RefThumb } from '@/components/canvas/PromptEditor'
import { NodeBodyCtx } from './types'
import {
  buildNineGridLoopPrompt,
  buildNativeGifPrompt,
  gridFrameCount,
  normalizeGrid,
  normalizeOutputMode,
  parseNineGridScript,
  splitNineGridActions,
} from '@/lib/nine-grid-loop'

// 音频上传节点填写面板：说明（透传模式，可提示下游接线）
export function AudioUploadPanel(ctx: NodeBodyCtx) {
  return (
    <div className="px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">在卡身录音或上传音频；把本节点输出「音频」连到 语音识别 / 人声分离 / 音频预览 等下游节点即可使用</label>
    </div>
  )
}

// =====================================================================
// 上参数条：点击节点后弹出在卡片上方（横向长条，模型名完整显示）
// =====================================================================

export function AudioGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="输入要合成的内容（配音文本 / 音乐描述）…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">歌词（音乐模型）</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.lyrics ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'lyrics', e.target.value)}
          placeholder="可选，支持 [Verse]/[Chorus] 等结构标签"
          autoSize={{ minRows: 1, maxRows: 6 }}
        />
      </details>
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">音色（配音模型）</summary>
        <Input
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.voiceId ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'voiceId', e.target.value)}
          placeholder="可选，配音音色 ID"
        />
      </details>
    </div>
  )
}

// 音乐生成节点填写面板：重点歌词 + 风格描述
export function MusicGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="音乐风格描述（如：Indie folk, melancholic）…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <details className="group" open={Boolean(ctx.node.inputs.lyrics)}>
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">歌词</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.lyrics ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'lyrics', e.target.value)}
          placeholder="填入歌词，支持 [Verse]/[Chorus]/[Bridge] 结构标签"
          autoSize={{ minRows: 2, maxRows: 8 }}
        />
      </details>
    </div>
  )
}

// 配音生成节点填写面板：重点文本 + 音色
export function TtsGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="输入要合成语音的文本…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">音色</summary>
        <Input
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.voiceId ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'voiceId', e.target.value)}
          placeholder="可选，配音音色 ID（如 English_expressive_narrator）"
        />
      </details>
    </div>
  )
}

// 音效生成填写面板：音效描述 + 可选固定时长
export function SfxGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="描述想要的音效，如「大雨落在金属屋顶」「科幻界面滴答声」…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <InputNumber
        size="small"
        variant="borderless"
        className="w-24"
        min={1}
        max={10}
        value={typeof ctx.node.inputs.duration === 'number' ? ctx.node.inputs.duration : undefined}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'duration', v ?? undefined)}
        placeholder="秒"
        addonAfter="秒"
        title="固定时长 1-10 秒，留空由模型自动决定"
      />
    </div>
  )
}

// 人声分离填写面板：无文本输入（音频来自上传/连线），给一句操作说明
export function VoiceIsolatePanel(ctx: NodeBodyCtx) {
  return (
    <div className="px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">待分离音频来自节点内上传或上游连线；运行后输出去除伴奏/环境音的人声轨道</label>
    </div>
  )
}

// =====================================================================
// 下填写面板：点击节点后弹出在卡片下方（横向，宽 > 高）
// =====================================================================

export function LLMPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="输入提示词…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">系统提示词</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.systemPrompt ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'systemPrompt', e.target.value)}
          placeholder="可选，设定模型角色与规则"
          autoSize={{ minRows: 1, maxRows: 4 }}
        />
      </details>
    </div>
  )
}

// 九宫格循环帧：一个「分镜脚本」文本框写完四个小节（【角色】【场景】【动作】【画风】），
// 解析和提示词构造都在 lib/nine-grid-loop.ts —— 画布、工具页、预览共用同一份逻辑。
export function NineGridLoopPanel(ctx: NodeBodyCtx) {
  const script = String(ctx.node.inputs.script ?? '')
  const grid = normalizeGrid(ctx.node.inputs.grid)
  const outputMode = normalizeOutputMode(ctx.node.inputs.outputMode)
  const nativeGif = outputMode === 'native-gif'
  const frameCount = gridFrameCount(grid)
  const parsed = script.trim() ? parseNineGridScript(script) : null
  const actionCount = parsed ? splitNineGridActions(parsed.actions).length : 0
  const sectionsOk = parsed ? Boolean(parsed.character.trim()) && Boolean(parsed.scene.trim()) : false
  const freeform = Boolean(parsed && !parsed.character && !parsed.scene && !parsed.actions)
  const statusText = nativeGif
    ? (parsed ? `原生 GIF · ${actionCount} 段关键动作` : '原生 GIF：写一段描述，或按【】分镜填写')
    : !parsed
      ? `按小节填写：角色 / 场景 / 动作(${frameCount}行) / 画风，或直接写一段描述`
      : `${sectionsOk ? '✓ 角色·场景' : (freeform ? '自由描述模式' : '缺 角色 或 场景')} · ${actionCount}/${frameCount} 帧`
  const statusOk = nativeGif
    ? Boolean(parsed) && (actionCount >= 2 || freeform)
    : Boolean(parsed) && (actionCount === frameCount || freeform)
  let preview = ''
  try {
    if (!parsed) {
      preview = '按模板填写后自动生成最终提示词'
    } else {
      const structured = Boolean(parsed.character || parsed.scene || parsed.actions)
      const promptInput = structured
        ? { ...parsed, grid, outputMode }
        : {
          brief: script
            .split(/\r?\n/)
            .filter((line) => !/^\s*(画风|风格|宫格|宫格规格|生成方式)\s*[:：]/.test(line))
            .join('\n')
            .trim() || script,
          style: parsed.style,
          grid,
          outputMode,
        }
      preview = nativeGif ? buildNativeGifPrompt(promptInput) : buildNineGridLoopPrompt(promptInput)
    }
  } catch (err) {
    preview = err instanceof Error ? err.message : '请先补全角色、场景与 9 帧动作'
  }

  return (
    <div className="space-y-2 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      {ctx.refImages.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {ctx.refImages.map((src, i) => <RefThumb key={i} src={src} index={i} />)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[10px] text-text-secondary">输出</span>
        <Select
          size="small"
          className="w-32"
          value={nativeGif ? 'native-gif' : 'grid'}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'outputMode', v)}
          options={[
            { value: 'grid', label: '宫格图' },
            { value: 'native-gif', label: '原生 GIF' },
          ]}
        />
      </div>
      {!nativeGif && (
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] text-text-secondary">宫格</span>
        <Select
          size="small"
          className="w-32"
          value={grid === 4 ? '4×4（16帧）' : '3×3（9帧）'}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'grid', v)}
          options={[
            { value: '3×3（9帧）', label: '3×3（9帧）' },
            { value: '4×4（16帧）', label: '4×4（16帧）' },
          ]}
        />
      </div>
      )}
      <label className="block text-[10px] text-text-secondary">
        分镜脚本
        <span className={`ml-1 ${statusOk ? 'text-success' : 'text-warning-deep'}`}>{statusText}</span>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={script}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'script', e.target.value)}
          placeholder={nativeGif
            ? '【角色】通体雪白绒毛、超大垂耳、红宝石圆眼\n【场景】正面略俯视，屏幕/正脸/饭碗全程可见\n【动作】\n1. 起始动作\n…\n8. 收尾并接回开头\n【画风】Q版二次元平涂（可省略）\n或只写一段创作描述，让模型自己设计动画'
            : `【角色】通体雪白绒毛、超大垂耳、红宝石圆眼\n【场景】正面略俯视，屏幕/正脸/饭碗全程可见\n【动作】\n1. 端正坐好，看向屏幕\n…\n${frameCount}. 回到与第 1 帧完全一致\n【画风】Q版二次元平涂（可省略）\n或只写一段创作描述，交给模型自己排帧`}
          autoSize={{ minRows: 8, maxRows: 16 }}
        />
      </label>
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">负向提示词</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.negativePrompt ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'negativePrompt', e.target.value)}
          placeholder="不希望出现的元素，可选"
          autoSize={{ minRows: 1, maxRows: 3 }}
        />
      </details>
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">查看最终提示词</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-black/5 p-2 text-[10px] leading-relaxed text-text-secondary">
          {preview}
        </pre>
      </details>
    </div>
  )
}

// 九宫格转 GIF：切帧 + 合成都在服务端完成，这里只暴露最常用的四个参数。
export function Grid9GifPanel(ctx: NodeBodyCtx) {
  const delayMs = Number(ctx.node.inputs.delayMs) || 150
  const grid = normalizeGrid(ctx.node.inputs.grid)
  const total = gridFrameCount(grid)
  const rawMode = String(ctx.node.inputs.mode ?? 'normal').trim().toLowerCase()
  const mode = ['pingpong', 'ping-pong', '往返乒乓', '乒乓', '往返'].includes(rawMode) ? 'pingpong' : 'normal'
  return (
    <div className="space-y-2 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] text-text-secondary">帧间隔</span>
        <InputNumber
          size="small"
          min={20}
          max={5000}
          step={10}
          value={delayMs}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'delayMs', v ?? 150)}
          addonAfter="ms"
          className="w-28"
        />
        <Select
          size="small"
          className="w-28"
          value={mode}
          onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'mode', v)}
          options={[
            { value: 'normal', label: '正序循环' },
            { value: 'pingpong', label: '往返乒乓' },
          ]}
        />
        <Select
          size="small"
          className="w-32"
          value={grid === 4 ? '4×4（16帧）' : '3×3（9帧）'}
          onChange={(v) => {
            ctx.onUpdateInput(ctx.node.id, 'grid', v)
            const rawFrames = String(ctx.node.inputs.frames ?? '').trim()
            if (!rawFrames || rawFrames === '1-9' || rawFrames === '1-16') {
              ctx.onUpdateInput(ctx.node.id, 'frames', v.startsWith('4') ? '1-16' : '1-9')
            }
          }}
          options={[
            { value: '3×3（9帧）', label: '3×3（9帧）' },
            { value: '4×4（16帧）', label: '4×4（16帧）' },
          ]}
        />
      </div>
      <label className="block text-[10px] text-text-secondary">
        帧选择
        <Input
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.frames ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'frames', e.target.value)}
          placeholder={`1-${total}，或 1,3,5,7,9；填写顺序即播放顺序`}
        />
      </label>
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">精细参数</summary>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            裁格线
            <InputNumber
              size="small"
              min={0}
              max={10}
              step={0.5}
              value={Number(ctx.node.inputs.trimPercent ?? 1)}
              onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'trimPercent', v ?? 1)}
              addonAfter="%"
              className="w-24"
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            最长边
            <InputNumber
              size="small"
              min={64}
              max={1024}
              step={64}
              value={Number(ctx.node.inputs.maxSize ?? 512)}
              onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'maxSize', v ?? 512)}
              className="w-24"
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            背景
            <Input
              size="small"
              className="w-24"
              value={String(ctx.node.inputs.background ?? '#ffffff')}
              onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'background', e.target.value)}
              placeholder="#ffffff / transparent"
            />
          </label>
        </div>
      </details>
      <p className="text-[10px] text-text-muted">
        纯本地处理，不扣积分。第 9 帧与第 1 帧相同时保持两帧，循环不会少一拍。
      </p>
    </div>
  )
}

export function ImageGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      {ctx.refImages.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {ctx.refImages.map((src, i) => <RefThumb key={i} src={src} index={i} />)}
        </div>
      )}
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={ctx.refImages.map((src) => ({ src }))}
        placeholder="描述画面，用「第一张图/第二张图」指代已连接的参考图…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">负向提示词</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.negativePrompt ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'negativePrompt', e.target.value)}
          placeholder="不希望出现的元素，可选"
          autoSize={{ minRows: 1, maxRows: 3 }}
        />
      </details>
    </div>
  )
}

export function VideoGenPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <PromptEditor
        value={String(ctx.node.inputs.prompt ?? '')}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'prompt', v)}
        references={[]}
        placeholder="描述视频画面…"
        fill
        className="rounded-[10px] bg-white/45 border border-accent-border/60 focus-within:border-accent/60 transition-colors text-xs"
        minHeight="48px"
      />
      {(Boolean(ctx.node.inputs.firstFrame) || Boolean(ctx.node.inputs.lastFrame)) && (
        <div className="flex gap-1.5">
          {(['firstFrame', 'lastFrame'] as const).filter((k) => typeof ctx.node.inputs[k] === 'string' && ctx.node.inputs[k]).map((k) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
            draggable={false}
              key={k}
              src={String(ctx.node.inputs[k])}
              alt={k === 'firstFrame' ? '首帧' : '尾帧'}
              title={k === 'firstFrame' ? '首帧图' : '尾帧图'}
              className="h-12 w-[72px] rounded border border-border object-cover"
            />
          ))}
        </div>
      )}
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] text-text-secondary hover:text-primary">负向提示词</summary>
        <Input.TextArea
          size="small"
          className="mt-1 text-[11px]"
          value={String(ctx.node.inputs.negativePrompt ?? '')}
          onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'negativePrompt', e.target.value)}
          placeholder="不希望出现的元素，可选"
          autoSize={{ minRows: 1, maxRows: 3 }}
        />
      </details>
    </div>
  )
}

// =====================================================================
// 分派
// =====================================================================

// =====================================================================
// 逻辑/数据类节点三层适配：结果卡身 + 上参数条 + 下填写面板
// =====================================================================

// ========== 人脸涂鸦：下方填写面板（对应 ImageGenPromptPanel 的位置）============
//
// 承担「看得见的框状态」：几个框、哪些是兜底补的、每个框多大。
// 原来的问题：用户手动补完框后，框数只显示一个数字，无法判断漏在哪、
// 也不知道框的大小是否合适（框大小直接决定涂鸦粗细）。
export function FaceDoodlePanel(ctx: NodeBodyCtx) {
  const faces = Array.isArray(ctx.node.inputs.faces)
    ? (ctx.node.inputs.faces as { x?: number; y?: number; w?: number; h?: number; isFallback?: boolean; isManual?: boolean }[])
    : []
  const originalUrl = ctx.doodleImageUrl || ''
  const resultUrl = ctx.output?.imageUrl ? String(ctx.output.imageUrl) : ''
  const multiView = ctx.node.inputs.multiView !== false
  const autoFallback = ctx.node.inputs.autoFallback !== false

  const clearFaces = () => {
    ctx.onUpdateInput(ctx.node.id, 'faces', [])
  }

  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <div className="flex items-center gap-1.5">
      {/* 缩略图用原生 <img>：上游成果图是随机的外链，换 next/image 需要配 remotePatterns
          （等于把「能显示哪些厂商的图」变成部署配置），而这里已有 onError 兜底到 /placeholder.png。
          原先这条写的是 @nextjs/next/no-img-element —— **规则名不存在**，
          所以它不仅没起作用，还让 lint 多出两条「Definition for rule was not found」错误。 */}
      {/* eslint-disable-next-line @next/next/no-img-element -- 外链缩略图，理由见上 */}
        {originalUrl && (
          <img
            src={originalUrl}
            alt="原图"
            className="h-12 w-[72px] rounded border border-border object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
        )}
        <span className="text-[10px] text-text-secondary">原图</span>
        <span className="mx-0.5 text-text-disabled">→</span>
      {/* eslint-disable-next-line @next/next/no-img-element -- 同上：涂鸦结果也是外链缩略图 */}
        {resultUrl && (
          <img
            src={resultUrl}
            alt="涂鸦结果"
            className="h-12 w-[72px] rounded border border-border object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
        )}
        <span className="text-[10px] text-text-secondary">结果</span>
        <span className="flex-1" />
        <Tooltip title={multiView ? '切片扫描已开：四视图/分镜的小脸与侧脸更容易检出' : '切片扫描已关：只扫整图，小脸/侧脸可能漏检'}>
          <span className={`cursor-default rounded-full border px-1.5 py-0.5 text-[10px] ${
            multiView ? 'border-success/30 bg-success-bg/70 text-success' : 'border-border bg-black/5 text-text-disabled'
          }`}>切片</span>
        </Tooltip>
        <Tooltip title={autoFallback ? '补框已开：横长图检出的脸数少于列数时，按列推算补上（宁可多涂不可漏涂）' : '补框已关：检出几个就涂几个，可能漏涂'}>
          <span className={`cursor-default rounded-full border px-1.5 py-0.5 text-[10px] ${
            autoFallback ? 'border-success/30 bg-success-bg/70 text-success' : 'border-border bg-black/5 text-text-disabled'
          }`}>补框</span>
        </Tooltip>
        {faces.length > 0 && (
          <Button size="small" type="text" danger onClick={clearFaces} className="!h-5 !px-1.5 !text-[10px]">
            清空 {faces.length} 框
          </Button>
        )}
      </div>

      {faces.length === 0 ? (
        <div className="py-1 text-center text-[10px] text-text-disabled">
          还没有涂鸦框 —— 点「工作台」自动扫描，手动漏检可在工作台里拖拽补
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {faces.map((f, i) => {
            const kind = f.isFallback ? '兜底' : f.isManual ? '手动' : '检测'
            const tone = f.isFallback ? 'border-warning/40 bg-warning-bg/70 text-warning-strong' : f.isManual ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-black/5 text-text-secondary'
            return (
              <span
                key={i}
                title={`${kind}框 · ${Math.round(f.w ?? 0)}×${Math.round(f.h ?? 0)}px`}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${tone}`}
              >
                {kind} {Math.round(f.w ?? 0)}×{Math.round(f.h ?? 0)}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 字段提取下填写面板：要提取的字段名（items 数组来自上游连线）
export function FieldExtractorPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">对象数组来自上游连线（如 JSON 解析的 items）；此处填要提取的字段名</label>
      <Input
        size="small"
        className="rounded-[10px] bg-white/45 text-[11px]"
        value={String(ctx.node.inputs.field ?? 'prompt')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'field', e.target.value)}
        placeholder="如 prompt / url / title"
      />
    </div>
  )
}

// ===== 逻辑/数据类下填写面板（数据输入区）=====

export function JsonParserPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">JSON 字符串（支持顶层数组 / items / data / results 等结构）</label>
      <Input.TextArea
        size="small"
        className="rounded-[10px] bg-white/45 text-[11px]"
        value={String(ctx.node.inputs.jsonInput ?? '')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'jsonInput', e.target.value)}
        placeholder='[{"prompt":"..."},...]'
        autoSize={{ minRows: 3, maxRows: 10 }}
      />
    </div>
  )
}

export function BatchPromptPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">{'JSON 语块（每套一块，如 [{"prompt":"…"},{"prompt":"…"}]）'}</label>
      <Input.TextArea
        size="small"
        className="rounded-[10px] bg-white/45 text-[11px]"
        value={String(ctx.node.inputs.json ?? '')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'json', e.target.value)}
        placeholder='[{"prompt":"第一套"},{"prompt":"第二套"}]'
        autoSize={{ minRows: 3, maxRows: 10 }}
      />
    </div>
  )
}

export function ConditionCheckPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">比较值（与上游输入比较；也可直接填字面量）</label>
      <Input.TextArea
        size="small"
        className="rounded-[10px] bg-white/45 text-[11px]"
        value={String(ctx.node.inputs.compareTo ?? '')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'compareTo', e.target.value)}
        placeholder="如 hello 或 100"
        autoSize={{ minRows: 1, maxRows: 3 }}
      />
    </div>
  )
}

export function TextConcatPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">文本 A 与 B 来自上游连线；此处可覆盖 A 的内容</label>
      <Input.TextArea
        size="small"
        className="rounded-[10px] bg-white/45 text-[11px]"
        value={String(ctx.node.inputs.textA ?? '')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'textA', e.target.value)}
        placeholder="可选，覆盖文本 A"
        autoSize={{ minRows: 1, maxRows: 4 }}
      />
    </div>
  )
}

export function NumberCalcPanel(ctx: NodeBodyCtx) {
  return (
    <div className="space-y-1.5 px-2.5 py-2" onPointerDown={ctx.stopPropagation}>
      <label className="text-[10px] text-text-secondary">操作数（未连线时使用此处数值）</label>
      <div className="flex gap-2">
        <InputNumber size="small" className="flex-1 rounded-[10px]" value={typeof ctx.node.inputs.a === 'number' ? ctx.node.inputs.a : 0} onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'a', v ?? 0)} placeholder="A" onPointerDown={ctx.stopPropagation} />
        <InputNumber size="small" className="flex-1 rounded-[10px]" value={typeof ctx.node.inputs.b === 'number' ? ctx.node.inputs.b : 0} onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'b', v ?? 0)} placeholder="B" onPointerDown={ctx.stopPropagation} />
      </div>
    </div>
  )
}

// =====================================================================
// 分派
// =====================================================================
