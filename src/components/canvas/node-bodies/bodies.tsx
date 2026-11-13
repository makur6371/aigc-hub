'use client'

import { useState, useRef } from 'react'
import { Button, InputNumber, Input } from 'antd'
import { UpOutlined, ScissorOutlined, UploadOutlined } from '@ant-design/icons'
import { NodeBodyCtx } from './types'
import { normalizeOutputMode } from '@/lib/nine-grid-loop'
import { ResultLabel, TextResult, MediaActions, AudioWave, WavePlayer } from './shared'
import { apiFetch } from '@/lib/api-client'

// LLM 对话节点卡身：结果文本铺满 + 左上角 LLM 标注
export function LLMChatBody(ctx: NodeBodyCtx) {
  const text = ctx.output && ctx.output.text !== undefined ? String(ctx.output.text) : null
  return (
    <div className="relative -my-2">
      <ResultLabel text="LLM 对话" color="#7d50e0" />
      {text !== null && text !== '' ? (
        <TextResult text={text} />
      ) : (
        <div className="flex h-24 items-center justify-center text-[11px] text-text-disabled">运行后显示生成文本</div>
      )}
    </div>
  )
}

// 图像生成节点卡身：结果图铺满 + 左上角标注
export function ImageGenerateBody(ctx: NodeBodyCtx) {
  const imageUrl = ctx.output && typeof ctx.output.imageUrl === 'string' ? ctx.output.imageUrl : null
  const gifUrl = ctx.output && typeof ctx.output.gifUrl === 'string' ? ctx.output.gifUrl : null
  const src = gifUrl || imageUrl
  const label =
    ctx.node.type === 'nine-grid-loop'
      ? (normalizeOutputMode(ctx.node.inputs.outputMode) === 'native-gif' ? '循环 GIF' : '九宫格循环帧')
    : ctx.node.type === 'grid9-to-gif' ? '循环 GIF'
    : '图像生成'
  return (
    <div className="relative -my-2">
      <ResultLabel text={label} color="#7d50e0" />
      {src ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            draggable={false}
            src={src}
            alt="生成结果"
            className="w-full bg-surface"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
          <MediaActions
            src={src}
            kind="image"
            onPreview={ctx.onPreviewImage}
            onDerive={ctx.node.type === 'grid9-to-gif' || !ctx.onDeriveNode
              ? undefined
              : (type) => ctx.onDeriveNode!(ctx.node.id, type, src)}
          />
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center text-[11px] text-text-disabled">运行后显示生成图片</div>
      )}
    </div>
  )
}

// 图片上传/批量上传节点卡身：图片铺满 + 角落小上传按钮
export function ImageUploadBody(ctx: NodeBodyCtx & { onUploadFiles: (files: FileList | File[]) => void }) {
  const inputRef = ctx.node.inputs as Record<string, unknown>
  const isBatch = ctx.node.type === 'image-upload-batch'
  const images = isBatch && Array.isArray(inputRef.images)
    ? (inputRef.images as string[]).filter((v) => typeof v === 'string' && /^(data:image|https?:|\/)/.test(v))
    : (() => { const v = inputRef.image ?? inputRef.imageUrl; return typeof v === 'string' && /^(data:image|https?:|\/)/.test(v) ? [v] : [] })()

  return (
    <div className="relative -my-2">
      <ResultLabel text={isBatch ? '批量上传' : '图片上传'} color="#52c41a" />
      {images.length === 1 && (
        <MediaActions
          src={images[0]}
          kind="image"
          onPreview={ctx.onPreviewImage}
          onDerive={ctx.onDeriveNode ? (type) => ctx.onDeriveNode!(ctx.node.id, type, images[0]) : undefined}
        />
      )}
      {images.length > 0 ? (
        images.length === 1 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            draggable={false}
            src={images[0]}
            alt="已上传"
            className="max-h-[360px] w-full object-contain"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
        ) : (
          <div className="grid grid-cols-2 gap-0.5">
            {images.slice(0, 6).map((img, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
            draggable={false}
                  src={img}
                  alt={`图 ${i + 1}`}
                  className="h-28 w-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
                />
                <span className="absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent/90 text-[9px] font-medium text-white">{i + 1}</span>
              </div>
            ))}
            {images.length > 6 && (
              <span className="flex h-28 items-center justify-center bg-surface text-[10px] text-text-secondary">+{images.length - 6}</span>
            )}
          </div>
        )
      ) : (
        <button
          type="button"
          data-paste-zone
          tabIndex={0}
          onClick={() => document.getElementById(`upload-input-${ctx.node.id}`)?.click()}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f)
            if (files.length > 0) ctx.onUploadFiles(files)
          }}
          className="flex h-28 w-full flex-col items-center justify-center gap-1 text-text-muted transition-colors hover:bg-surface"
          onPointerDown={ctx.stopPropagation}
        >
          <span className="text-xs">点击 / 粘贴{isBatch ? ' / 多选' : ''} 上传图片</span>
        </button>
      )}
      {/* 换图入口：有图时排在 MediaActions 下方（top-10 避让三连按钮）；无图时右上角 */}
      <button
        type="button"
        title="上传图片"
        onClick={(e) => { e.stopPropagation(); document.getElementById(`upload-input-${ctx.node.id}`)?.click() }}
        onPointerDown={ctx.stopPropagation}
        className={`absolute right-1.5 z-10 grid size-6 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/65 ${images.length === 1 ? 'top-10' : 'top-1.5'}`}
      >
        <UpOutlined className="text-[10px]" />
      </button>
      {/* 空态拖拽柄：空上传节点整卡是粘贴区（排除拖拽），悬停浮现柄提供拖动入口 */}
      {images.length === 0 && (
        <span
          data-node-drag-handle
          title="拖动节点"
          className="absolute left-1.5 top-1.5 z-10 grid size-7 cursor-grab place-items-center rounded-full bg-accent/25 text-accent opacity-0 backdrop-blur transition-opacity duration-150 group-hover:opacity-100 max-lg:opacity-100 active:cursor-grabbing"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="9" cy="6" r="1" fill="currentColor" /><circle cx="15" cy="6" r="1" fill="currentColor" />
            <circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" />
            <circle cx="9" cy="18" r="1" fill="currentColor" /><circle cx="15" cy="18" r="1" fill="currentColor" />
          </svg>
        </span>
      )}
      <input
        id={`upload-input-${ctx.node.id}`}
        type="file"
        accept="image/*"
        multiple={isBatch}
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) ctx.onUploadFiles(e.target.files); e.target.value = '' }}
      />
    </div>
  )
}

// 图片预览节点卡身
export function ImagePreviewBody(ctx: NodeBodyCtx) {
  const src = (() => {
    if (ctx.output && typeof ctx.output.imageUrl === 'string') return ctx.output.imageUrl
    const v = ctx.node.inputs.imageUrl
    return typeof v === 'string' && v ? v : null
  })()
  if (!src) {
    return (
      <div className="relative -my-2 flex h-24 items-center justify-center text-[11px] text-text-disabled">
        <ResultLabel text="预览" color="#4fc3f7" />
        连接图片输入后预览
      </div>
    )
  }
  return (
    <div className="relative -my-2">
      <ResultLabel text="预览" color="#4fc3f7" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
            draggable={false}
        src={src}
        alt="预览"
        className="w-full"
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
      />
      <MediaActions
        src={src}
        kind="image"
        onPreview={ctx.onPreviewImage}
        onDerive={ctx.onDeriveNode ? (type) => ctx.onDeriveNode!(ctx.node.id, type, src) : undefined}
      />
    </div>
  )
}

// 视频预览节点卡身
export function VideoPreviewBody(ctx: NodeBodyCtx) {
  const src = (() => {
    if (ctx.output && typeof ctx.output.videoUrl === 'string') return ctx.output.videoUrl
    const v = ctx.node.inputs.videoUrl
    return typeof v === 'string' && v ? v : null
  })()
  if (!src) {
    return (
      <div className="relative -my-2 flex h-24 items-center justify-center text-[11px] text-text-disabled">
        <ResultLabel text="视频预览" color="#b25e09" />
        连接视频输入后预览
      </div>
    )
  }
  return (
    <div className="relative -my-2">
      <ResultLabel text="视频预览" color="#b25e09" />
      { }
      <video src={src} controls className="w-full" style={{ maxHeight: 288 }} />
      <MediaActions src={src} kind="video" onPreview={ctx.onPreviewVideo} />
    </div>
  )
}

// 视频生成节点卡身
export function VideoGenerateBody(ctx: NodeBodyCtx) {
  const videoUrl = ctx.output && typeof ctx.output.videoUrl === 'string' ? ctx.output.videoUrl : null
  return (
    <div className="relative -my-2">
      <ResultLabel text="视频生成" color="#b25e09" />
      {videoUrl ? (
        <div className="relative">
          { }
          <video src={videoUrl} controls className="w-full" style={{ maxHeight: 288 }} />
          <MediaActions src={videoUrl} kind="video" onPreview={ctx.onPreviewVideo} />
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center text-[11px] text-text-disabled">运行后显示生成视频</div>
      )}
    </div>
  )
}

// 音频预览节点卡身
export function AudioPreviewBody(ctx: NodeBodyCtx) {
  const src = (() => {
    if (ctx.output && typeof ctx.output.audioUrl === 'string') return ctx.output.audioUrl
    const v = ctx.node.inputs.audioUrl
    return typeof v === 'string' && v ? v : null
  })()
  if (!src) {
    return (
      <div className="relative -my-2">
        <ResultLabel text="音频预览" color="#6a5ae0" />
        <AudioWave className="h-28 text-text-disabled" center={<span className="text-[11px]">连接音频输入后预览</span>} />
      </div>
    )
  }
  return (
    <div className="relative -my-2">
      <ResultLabel text="音频预览" color="#6a5ae0" />
      <div className="w-full">
        <WavePlayer src={src} />
      </div>
      <MediaActions src={src} kind="audio" onPreview={ctx.onPreviewVideo} />
    </div>
  )
}

// 人声分离卡身：节点内上传音频 → 分离出的人声预览
export function VoiceIsolateBody(ctx: NodeBodyCtx) {
  const media = (typeof ctx.node.inputs.media === 'string' && ctx.node.inputs.media) ? ctx.node.inputs.media : null
  const audioUrl = ctx.output && typeof ctx.output.audioUrl === 'string' ? ctx.output.audioUrl : null

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('source', 'canvas')
      const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
      if (r.success && r.data?.url) ctx.onUpdateInput(ctx.node.id, 'media', r.data.url)
    } catch { /* ignore */ }
  }

  return (
    <div className="relative -my-2 space-y-1.5 px-2 py-3">
      <ResultLabel text="人声分离" color="#6a5ae0" />
      {media ? (
        <WavePlayer src={media} compact />
      ) : (
        <AudioWave className="h-24 text-text-disabled" center={<span className="text-[11px]">请上传待分离的音频</span>} />
      )}
      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-text-secondary hover:text-primary">
        <UploadOutlined className="text-xs" />
        选择音频文件
        <input type="file" accept="audio/*" className="hidden" onChange={onPick} />
      </label>
      {audioUrl && (
        <div className="space-y-1 border-t border-border/60 pt-1.5">
          <span className="text-[10px] text-text-muted">分离出的人声</span>
          <WavePlayer src={audioUrl} compact />
          <MediaActions src={audioUrl} kind="audio" onPreview={ctx.onPreviewVideo} />
        </div>
      )}
    </div>
  )
}

// 音效生成卡身：运行后显示多变体网格（选第一个为主输出）
export function SfxGenerateBody(ctx: NodeBodyCtx) {
  const audioUrl = ctx.output && typeof ctx.output.audioUrl === 'string' ? ctx.output.audioUrl : null
  const variants = ctx.output && Array.isArray(ctx.output.audioUrls)
    ? (ctx.output.audioUrls as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return (
    <div className="relative -my-2 w-full">
      <ResultLabel text="音效生成" color="#6a5ae0" />
      {audioUrl ? (
        <div className="space-y-1.5">
          <div className="relative">
            <WavePlayer src={audioUrl} />
            <MediaActions src={audioUrl} kind="audio" onPreview={ctx.onPreviewVideo} />
          </div>
          {variants.length > 1 && (
            <div className="space-y-1 border-t border-border/60 pt-1">
              <span className="text-[10px] text-text-muted">全部变体（{variants.length}）</span>
              {variants.map((v, i) => (
                <WavePlayer key={i} src={v} compact />
              ))}
            </div>
          )}
        </div>
      ) : (
        <AudioWave className="h-32 text-text-disabled" center={<span className="rounded-full bg-white/60 px-3 py-1 text-[11px] text-text-secondary backdrop-blur">运行后显示音效</span>} />
      )}
    </div>
  )
}

export function AudioGenerateBody(ctx: NodeBodyCtx) {
  const audioUrl = ctx.output && typeof ctx.output.audioUrl === 'string' ? ctx.output.audioUrl : null
  const label = ctx.node.type === 'music-generate' ? '音乐生成' : ctx.node.type === 'tts-generate' ? '配音生成' : '音频生成'
  return (
    <div className="relative -my-2 w-full">
      <ResultLabel text={label} color="#6a5ae0" />
      {audioUrl ? (
        <div className="relative">
          <WavePlayer src={audioUrl} />
          <MediaActions src={audioUrl} kind="audio" onPreview={ctx.onPreviewVideo} />
        </div>
      ) : (
        <AudioWave className="h-32 text-text-disabled" center={<span className="rounded-full bg-white/60 px-3 py-1 text-[11px] text-text-secondary backdrop-blur">运行后显示生成音频</span>} />
      )}
    </div>
  )
}

// 音频上传节点卡身：本地上传音频 + 实时录音（MediaRecorder），音频可播放预览，透传给下游 ASR/人声分离
export function AudioUploadBody(ctx: NodeBodyCtx & { onUploadFiles?: (files: FileList | File[]) => void }) {
  const audio = (typeof ctx.node.inputs.audio === 'string' && ctx.node.inputs.audio) ? ctx.node.inputs.audio : null
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 录音状态
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const uploadFile = async (raw: Blob, name: string) => {
    const fd = new FormData()
    fd.append('file', raw)
    fd.append('source', 'canvas-audio')
    try {
      const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
      if (r.success && r.data?.url) ctx.onUpdateInput(ctx.node.id, 'audio', r.data.url)
    } catch { /* ignore */ }
  }

  const onPickLocal = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await uploadFile(file, file.name || 'audio')
  }

  const stopRec = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    setRecording(false)
    setRecordSeconds(0)
  }

  const toggleRec = async () => {
    if (recording) { stopRec(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      streamRef.current = stream
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 0) await uploadFile(blob, `record-${Date.now()}.webm`)
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
      setRecordSeconds(0)
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    } catch { /* 麦克风不可用或未授权 */ }
  }

  const fmtRec = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  return (
    <div className="relative -my-2 space-y-1.5 px-2 py-3 group/au">
      <ResultLabel text="语音上传" color="#52c41a" />
      {audio ? (
        <WavePlayer src={audio} />
      ) : (
        <AudioWave className="h-24 text-text-disabled" center={<span className="text-[11px]">请上传音频或录音</span>} />
      )}
      {/* 操作区：录音按钮 + 本地上传 + 拖拽柄 */}
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          {/* 录音 */}
          <button
            type="button"
            onPointerDown={ctx.stopPropagation}
            onClick={toggleRec}
            title={recording ? '停止录音' : '开始实时录音'}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              recording ? 'bg-danger-bg text-danger animate-pulse' : 'bg-surface-hover text-text-secondary hover:text-primary'
            }`}
          >
            {recording ? <span className="size-1.5 rounded-full bg-danger" /> : <UpOutlined className="text-xs" />}
            {recording ? `录音中 ${fmtRec(recordSeconds)}` : '实时录音'}
          </button>
          {/* 本地上传 */}
          <button
            type="button"
            onPointerDown={ctx.stopPropagation}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-text-secondary hover:text-primary"
          >
            <UploadOutlined className="text-xs" />
            选择音频
          </button>
          <input ref={inputRef} type="file" accept="audio/*" className="hidden" onChange={onPickLocal} />
        </div>
        {/* 拖拽柄（audio 全卡可击，避免误拖） */}
        <span
          data-node-drag-handle
          title="拖动节点"
          className="grid size-7 cursor-grab place-items-center rounded-full bg-accent/25 text-accent opacity-0 backdrop-blur transition-opacity duration-150 group-hover/au:opacity-100 max-lg:opacity-100 active:cursor-grabbing"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="9" cy="6" r="1" fill="currentColor" /><circle cx="15" cy="6" r="1" fill="currentColor" />
            <circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" />
            <circle cx="9" cy="18" r="1" fill="currentColor" /><circle cx="15" cy="18" r="1" fill="currentColor" />
          </svg>
        </span>
      </div>
    </div>
  )
}

// 感知节点卡身：节点内直接上传音频/图片 → 识别文本
export function PerceptionBody(ctx: NodeBodyCtx) {
  const isAsr = ctx.node.type === 'transcribe'
  const media = (typeof ctx.node.inputs.media === 'string' && ctx.node.inputs.media) ? ctx.node.inputs.media : null
  const text = (ctx.output && typeof ctx.output.text === 'string') ? ctx.output.text : null

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('source', 'canvas')
      const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
      if (r.success && r.data?.url) ctx.onUpdateInput(ctx.node.id, 'media', r.data.url)
    } catch { /* ignore */ }
  }

  return (
    <div className="relative -my-2 space-y-1.5 px-2 py-3">
      <ResultLabel text={isAsr ? '语音识别' : '文字识别'} color="#6a5ae0" />
      {media ? (
        isAsr ? (
          <WavePlayer src={media} compact />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media} alt="待识别" className="max-h-40 w-auto rounded border border-border object-contain" />
        )
      ) : (
        <div className="text-center text-[11px] text-text-disabled">请上传{isAsr ? '音频' : '图片'}</div>
      )}
      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-text-secondary hover:text-primary">
        <UploadOutlined className="text-xs" />
        选择{isAsr ? '音频' : '图片'}文件
        <input type="file" accept={isAsr ? 'audio/*' : 'image/*'} className="hidden" onChange={onPick} />
      </label>
      {text && <div className="whitespace-pre-wrap break-words rounded bg-white/45 p-2 text-[11px] text-foreground">{text}</div>}
    </div>
  )
}

// 文本预览卡身：上游文本重放
export function TextPreviewBody(ctx: NodeBodyCtx) {
  const text = (() => {
    if (ctx.output && ctx.output.text !== undefined) return String(ctx.output.text)
    const v = ctx.node.inputs.text
    return typeof v === 'string' && v ? v : null
  })()
  if (!text) return (
    <div className="relative -my-2 flex h-20 items-center justify-center text-[11px] text-text-disabled">
      <ResultLabel text="文本预览" color="#4fc3f7" />
      连接文本输入后预览
    </div>
  )
  return (
    <div className="relative -my-2">
      <ResultLabel text="文本预览" color="#4fc3f7" />
      <TextResult text={text} />
    </div>
  )
}

// 数值输入卡身：大号数值直接编辑（输入源节点，无浮动层）
export function NumberInputBody(ctx: NodeBodyCtx) {
  return (
    <div className="relative -my-2 flex items-center justify-center px-4 py-5">
      <ResultLabel text="数值输入" color="#1677ff" />
      <InputNumber
        size="large"
        variant="borderless"
        className="w-full text-center text-lg font-medium"
        min={undefined}
        value={typeof ctx.node.inputs.value === 'number' ? ctx.node.inputs.value : 0}
        onChange={(v) => ctx.onUpdateInput(ctx.node.id, 'value', v ?? 0)}
        onPointerDown={ctx.stopPropagation}
      />
    </div>
  )
}

// 文本输入卡身：多行文本直接铺满卡身编辑；悬停浮现透明手形拖拽柄（输入框全程占卡，唯一可拖入口）
export function TextInputBody(ctx: NodeBodyCtx) {  return (
    <div className="relative -my-2 group/ti">
      <ResultLabel text="文本输入" color="#52c41a" />
      <Input.TextArea
        variant="borderless"
        className="min-h-[80px] resize-y w-full bg-transparent px-3 py-2 pl-3 text-xs leading-relaxed"
        value={String(ctx.node.inputs.content ?? '')}
        onChange={(e) => ctx.onUpdateInput(ctx.node.id, 'content', e.target.value)}
        placeholder="输入文本…"
        autoSize={{ minRows: 3, maxRows: 12 }}
        onPointerDown={ctx.stopPropagation}
      />
      {/* 拖拽柄：悬停浮现（卡片根 onPointerDown 对 [data-node-drag-handle] 放行拖拽） */}
      <span
        data-node-drag-handle
        title="拖动节点"
        className="pointer-events-auto absolute right-1.5 top-1.5 z-10 grid size-7 cursor-grab place-items-center rounded-full bg-accent/25 text-accent opacity-0 backdrop-blur transition-opacity duration-150 group-hover/ti:opacity-100 max-lg:opacity-100 active:cursor-grabbing"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="9" cy="6" r="1" fill="currentColor" /><circle cx="15" cy="6" r="1" fill="currentColor" />
          <circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" />
          <circle cx="9" cy="18" r="1" fill="currentColor" /><circle cx="15" cy="18" r="1" fill="currentColor" />
        </svg>
      </span>
    </div>
  )
}

// JSON 解析卡身：解析结果预览（条数+前几项摘要）
export function JsonParserBody(ctx: NodeBodyCtx) {
  const out = ctx.output as { items?: unknown[]; itemCount?: number } | null | undefined
  const liveItems = Array.isArray(out?.items) ? out.items : null
  const count = typeof out?.itemCount === 'number' ? out.itemCount : null
  return (
    <div className="relative -my-2 min-h-[80px] bg-surface/60 px-3 py-3">
      <ResultLabel text="JSON 解析" color="#52c41a" />
      <div className="pt-4 text-center">
        {count !== null ? (
          <>
            <div className="text-2xl font-semibold text-accent">{count}</div>
            <div className="text-[10px] text-text-secondary">条数据已解析</div>
          </>
        ) : (
          <span className="text-[11px] text-text-disabled">运行后显示解析结果</span>
        )}
      </div>
      {liveItems && liveItems.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5">
          {liveItems.slice(0, 3).map((it, i) => (
            <div key={i} className="truncate text-[10px] text-text-muted">{typeof it === 'object' ? JSON.stringify(it) : String(it)}</div>
          ))}
          {liveItems.length > 3 && <div className="text-[10px] text-text-disabled">…共 {liveItems.length} 条</div>}
        </div>
      )}
    </div>
  )
}

// 批量提示词卡身：语块数量预览
export function PromptBatchBody(ctx: NodeBodyCtx) {
  const out = ctx.output as { prompts?: unknown[]; count?: number } | null | undefined
  const inline = typeof ctx.node.inputs.json === 'string' && ctx.node.inputs.json ? ctx.node.inputs.json.split(/\n{2,}|\[\s*\]|\{/).filter(Boolean).length : 0
  const count = Array.isArray(out?.prompts) ? out.prompts.length : (typeof out?.count === 'number' ? out.count : (inline || null))
  return (
    <div className="relative -my-2 flex min-h-[80px] items-center justify-center bg-surface/60 py-6">
      <ResultLabel text="批量提示词" color="#faad14" />
      <div className="text-center">
        <div className="text-2xl font-semibold text-accent">{count ?? '—'}</div>
        <div className="text-[10px] text-text-secondary">套语块待展开</div>
      </div>
    </div>
  )
}

// 条件判断卡身：布尔结果大字显示
export function ConditionCheckBody(ctx: NodeBodyCtx) {
  const result = ctx.output?.result
  const has = ctx.output && typeof result === 'boolean'
  return (
    <div className="relative -my-2 flex min-h-[72px] items-center justify-center bg-surface/60 py-5">
      <ResultLabel text="条件判断" color="#1677ff" />
      {has ? (
        <span className={`text-xl font-bold ${result ? 'text-success' : 'text-danger'}`}>{result ? 'TRUE' : 'FALSE'}</span>
      ) : (
        <span className="text-[11px] text-text-disabled">运行后显示判断结果</span>
      )}
    </div>
  )
}

// 图片裁切卡身：原图/结果网格 + 打开工作台按钮 + 模式/区域摘要
export function ImageCropBody(ctx: NodeBodyCtx) {
  const cropImageUrl = (() => {
    if (ctx.cropImageUrl) return ctx.cropImageUrl
    if (Array.isArray(ctx.output?.images) && ctx.output.images.length > 0) return String(ctx.output.images[0])
    return null
  })()
  const regions = ctx.node.inputs.cropRegions as unknown[] | undefined
  const mode = ctx.node.inputs.mode as string | undefined
  const resultImages = Array.isArray(ctx.output?.images) ? (ctx.output.images as unknown[]).map(String) : []
  return (
    <div className="relative -my-2 min-h-[80px] px-3 py-3">
      <ResultLabel text="图片裁切" color="#52c41a" />
      {cropImageUrl && (
        <div className="mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cropImageUrl} alt="原图" className="max-w-full max-h-28 rounded object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }} />
        </div>
      )}
      {resultImages.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-secondary">{resultImages.length} 张裁切结果</div>
          <div className="grid grid-cols-3 gap-1">
            {resultImages.slice(0, 6).map((img: string, i: number) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={img} alt={`裁切${i}`} className="h-16 w-full object-cover rounded" onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }} />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2" onPointerDown={ctx.stopPropagation}>
        <Button size="small" icon={<ScissorOutlined />} onClick={() => ctx.onOpenWorkbench?.(ctx.node.id)}>
          打开工作台
        </Button>
        {(regions && regions.length > 0) ? (
          <span className="text-[10px] text-success">
            {mode === 'grid4' ? '四宫格' : mode === 'grid9' ? '九宫格' : '一宫格'} · 已选 {regions.length}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// 人脸智能涂鸦卡身：原图/结果 + 打开工作台按钮 + 框数摘要
export function FaceDoodleBody(ctx: NodeBodyCtx) {
  const doodleImageUrl = (() => {
    if (ctx.doodleImageUrl) return ctx.doodleImageUrl
    if (ctx.output?.imageUrl) return String(ctx.output.imageUrl)
    return null
  })()
  const faces = ctx.node.inputs.faces as unknown[] | undefined
  const resultUrl = ctx.output?.imageUrl ? String(ctx.output.imageUrl) : null
  return (
    <div className="relative -my-2">
      <ResultLabel text="人脸涂鸦" color="#f59e0b" />
      {/* 与「图像生成」一致：结果图铺满卡身；参数与框状态交给上/下浮动层 */}
      {resultUrl ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            draggable={false}
            src={resultUrl}
            alt="涂鸦结果"
            className="w-full bg-surface"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
          <MediaActions
            src={resultUrl}
            kind="image"
            onPreview={ctx.onPreviewImage}
            onDerive={ctx.onDeriveNode ? (type) => ctx.onDeriveNode!(ctx.node.id, type, resultUrl) : undefined}
          />
        </div>
      ) : doodleImageUrl ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            draggable={false}
            src={doodleImageUrl}
            alt="原图"
            className="w-full bg-surface"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/placeholder.png' }}
          />
          {faces && faces.length > 0 ? (
            <div className="absolute bottom-1 left-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">
              已框 {faces.length} 处 · 待出图
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center px-3 text-center text-[11px] text-text-disabled">
          连接图片输入后，选中本节点即可调参；点「工作台」自动扫描人脸
        </div>
      )}
    </div>
  )
}

// 数值计算卡身：计算结果大字显示
export function NumberCalcBody(ctx: NodeBodyCtx) {
  const result = ctx.output?.result
  const has = ctx.output && result !== undefined
  return (
    <div className="relative -my-2 flex min-h-[72px] items-center justify-center bg-surface/60 py-5">
      <ResultLabel text="数值计算" color="#1677ff" />
      {has ? (
        <span className="text-xl font-bold text-primary">{String(result)}</span>
      ) : (
        <span className="text-[11px] text-text-disabled">运行后显示计算结果</span>
      )}
    </div>
  )
}

// 文本拼接卡身：拼接结果重放
export function TextConcatBody(ctx: NodeBodyCtx) {
  const result = ctx.output?.result
  const has = ctx.output && typeof result === 'string'
  if (!has) return (
    <div className="relative -my-2 flex h-16 items-center justify-center text-[11px] text-text-disabled">
      <ResultLabel text="文本拼接" color="#4fc3f7" />
      运行后显示拼接结果
    </div>
  )
  return (
    <div className="relative -my-2">
      <ResultLabel text="文本拼接" color="#4fc3f7" />
      <TextResult text={String(result)} />
    </div>
  )
}

// 字段提取卡身：提取值数组预览
export function FieldExtractorBody(ctx: NodeBodyCtx) {
  const out = ctx.output as { values?: unknown[]; count?: number } | null | undefined
  const values = Array.isArray(out?.values) ? out.values : null
  const count = values ? values.length : (typeof out?.count === 'number' ? out.count : null)
  return (
    <div className="relative -my-2 min-h-[80px] bg-surface/60 px-3 py-3">
      <ResultLabel text="字段提取" color="#52c41a" />
      <div className="pt-4 text-center">
        {count !== null ? (
          <>
            <div className="text-2xl font-semibold text-accent">{count}</div>
            <div className="text-[10px] text-text-secondary">个值已提取</div>
          </>
        ) : (
          <span className="text-[11px] text-text-disabled">运行后显示提取结果</span>
        )}
      </div>
      {values && values.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5">
          {values.slice(0, 3).map((v, i) => (
            <div key={i} className="truncate text-[10px] text-text-muted">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
          ))}
          {values.length > 3 && <div className="text-[10px] text-text-disabled">…共 {values.length} 个</div>}
        </div>
      )}
    </div>
  )
}

// ===== 逻辑/数据类上参数条（操作区）=====
