'use client'

// ============================================================================
// 素材上传控件（按模态定制）—— 工具面板 / 画布 / 工作台共用
// ============================================================================
// 设计参照 GitHub 的上传交互（拖文件区 + 已选文件列表 + 逐项状态）：
//
//   1) 已选文件是主体，拖放区退为次要
//      原实现里大虚线框永远占着视觉重心，传了 5 张图之后它还在上面，
//      注意力被一个「已经不需要再拖」的空框抢走。
//      现在：没有文件时拖放区是主角；有了文件后缩成一条细横条，列表升为主体。
//
//   2) 按模态给不同的预览形态
//      原实现非图片一律显示同一个音符图标 —— 视频也画成音符，
//      用户分不出自己传的是视频还是音频。现在：
//        图片 → 真实缩略图
//        视频 → 播放器首帧 + 播放标记
//        音频 → 声波示意 + 扩展名
//
//   3) 状态分得清
//      「上传中」和「已完成」原来都是同尺寸方块，混在一起看不出谁在传。
//      现在上传中有旋转指示 + 文件名 + 大小，失败有独立红色态与原因。
//
//   4) 约束常驻可见 + 前置拦截
//      格式与 10MB 上限写在拖放区里（不用等失败才知道），并在前端先拦一道，
//      避免「选完文件转半天才被服务端拒绝」。
//
// 唯一上传通道仍是 POST /api/assets（TOOL_SYSTEM_DESIGN 附录 A.1），
// 本组件只负责交互与展示，不自己算配额、不自己落盘。

import { useRef, useState } from 'react'
import {
  UploadOutlined,
  LoadingOutlined,
  DeleteOutlined,
  PlayCircleFilled,
  SoundOutlined,
  VideoCameraOutlined,
  PictureOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
} from '@ant-design/icons'
import { MEDIA_KINDS, type MediaKind } from '@/lib/media-kinds'
import { toDisplayUrl } from '@/lib/media-url'
import { apiFetch } from '@/lib/api-client'

/** 与服务端 asset-store 的 ASSET_MAX_SIZE 一致（10MB）；不一致会导致「前端放行、后端拒绝」 */
const MAX_SIZE = 10 * 1024 * 1024

export type UploadItemState = 'uploading' | 'error'

export interface UploadingFile {
  /** 临时 key（文件名+时间戳+随机），用于列表 key 与状态更新 */
  key: string
  name: string
  size: number
  state: UploadItemState
  error?: string
  /**
   * 本地 blob 预览（Q-403）：选择文件后立即出缩略图，不等上传完成。
   * 只给 image / video 生成（audio 本来就是声波示意，无预览意义）。
   * 生命周期：上传循环结束后统一 revoke（成功项卡片被完成列表取代、
   * 失败项卡片只显示文字原因，两种情况都不再需要预览）。
   */
  previewUrl?: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function KindIcon({ kind, className }: { kind: MediaKind; className?: string }) {
  if (kind === 'video') return <VideoCameraOutlined className={className} />
  if (kind === 'audio') return <SoundOutlined className={className} />
  return <PictureOutlined className={className} />
}

export interface MediaUploaderProps {
  kind: MediaKind
  multiple?: boolean
  maxFiles?: number
  /** 已上传成功的站内地址（受控） */
  value: string[]
  onChange: (next: string[]) => void
  /** 上传中的临时项；不传则组件内部自持（面板级用法可省略） */
  uploading?: UploadingFile[]
  onUploadingChange?: (next: UploadingFile[]) => void
  onUploadActivityChange?: (active: boolean) => void
  disabled?: boolean
  className?: string
}

export function MediaUploader({
  kind,
  multiple = false,
  maxFiles,
  value,
  onChange,
  uploading,
  onUploadingChange,
  onUploadActivityChange,
  disabled,
  className = '',
}: MediaUploaderProps) {
  const kindMeta = MEDIA_KINDS[kind]
  const label = kindMeta.label
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadInFlight = useRef(false)
  const [dragOver, setDragOver] = useState(false)
  const [innerUploading, setInnerUploading] = useState<UploadingFile[]>([])
  const [notice, setNotice] = useState<string>('')

  // 受控优先；未传时用内部状态（两种用法都支持，调用方不必二选一）
  const pending = uploading ?? innerUploading
  const setPending = onUploadingChange ?? setInnerUploading

  const hasItems = value.length > 0 || pending.length > 0
  const isUploading = pending.some((file) => file.state === 'uploading')
  const remaining = maxFiles === undefined ? Infinity : Math.max(0, maxFiles - value.length)
  const uploadDisabled = disabled || isUploading || remaining === 0

  const uploadFiles = async (files: File[]) => {
    if (uploadDisabled || uploadInFlight.current || files.length === 0) return

    // 前置校验：类型 + 大小。服务端也会拦，这里先拦是为了即时反馈。
    const wrongType = files.filter((f) => !f.type.startsWith(kindMeta.mimePrefix))
    const oversize = files.filter((f) => f.size > MAX_SIZE)
    const valid = files.filter(
      (f) => f.type.startsWith(kindMeta.mimePrefix) && f.size <= MAX_SIZE,
    )
    const accepted = valid.slice(0, remaining)

    const msgs: string[] = []
    if (wrongType.length) msgs.push(`已忽略 ${wrongType.length} 个非${label}文件`)
    if (oversize.length) msgs.push(`${oversize.length} 个超过 ${formatSize(MAX_SIZE)} 未上传`)
    if (valid.length > accepted.length) msgs.push(`最多上传 ${maxFiles} 个${label}，超出部分未上传`)
    setNotice(msgs.join('；'))

    if (accepted.length === 0) return

    const items: UploadingFile[] = accepted.map((f) => ({
      key: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: f.name,
      size: f.size,
      state: 'uploading' as const,
      previewUrl: kind !== 'audio' ? URL.createObjectURL(f) : undefined,
    }))
    uploadInFlight.current = true
    onUploadActivityChange?.(true)
    setPending([...pending, ...items])

    const nextUrls = [...value]
    /** 本轮失败的项（结束后留在列表里显示原因） */
    const failures: UploadingFile[] = []
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const file = accepted[i]
        try {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('source', 'tool')
          const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
          if (!r.success || !r.data?.url) throw new Error(r.message || '上传失败')
          nextUrls.push(r.data.url)
        } catch (e) {
          const msg = e instanceof Error ? e.message : '上传失败'
          failures.push({ ...item, state: 'error' as const, error: msg })
        }
      }
      onChange(nextUrls)
    } finally {
      for (const item of items) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
      setPending(failures)
      uploadInFlight.current = false
      onUploadActivityChange?.(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    await uploadFiles(Array.from(e.dataTransfer.files || []))
  }

  const removeAt = (i: number) => {
    if (disabled || uploadInFlight.current) return
    const next = [...value]
    next.splice(i, 1)
    onChange(next)
  }

  const openPicker = () => {
    if (!uploadDisabled) inputRef.current?.click()
  }

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(Array.from(e.target.files || []))
    e.target.value = ''
  }

  return (
    <div className={className}>
      {/* ---- 拖放区：有文件时压缩为细条 ---- */}
      <div
        onDragEnter={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!uploadDisabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={openPicker}
        role="button"
        tabIndex={uploadDisabled ? -1 : 0}
        aria-label={`上传${label}`}
        aria-disabled={uploadDisabled}
        onKeyDown={(e) => {
          if (!uploadDisabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            openPicker()
          }
        }}
        className={[
          'relative select-none rounded-xl border border-dashed text-center transition-all duration-150',
          'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          dragOver
            ? 'scale-[1.01] border-accent bg-accent/8'
            : 'border-accent/30 bg-white/55 hover:border-accent/60 hover:bg-white/80',
          uploadDisabled ? 'cursor-not-allowed opacity-50' : '',
          hasItems ? 'px-3 py-2' : 'px-4 py-7',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={kindMeta.accept}
          multiple={multiple}
          className="hidden"
          onChange={onPick}
          disabled={uploadDisabled}
        />
        {hasItems ? (
          <div className="flex items-center justify-center gap-2 text-[12.5px] text-text-secondary">
            <UploadOutlined className="text-accent" />
            <span>{isUploading ? '上传中…' : remaining === 0 ? '已达数量上限' : value.length > 0 ? `继续添加${label}` : '选择文件'}</span>
            {!uploadDisabled && <span className="text-[11px] text-text-disabled">或拖拽到此处</span>}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
              <KindIcon kind={kind} className="text-lg" />
            </div>
            <div>
              <div className="text-[13px] font-medium text-foreground">
                点击选择<span className="text-accent"> 或拖拽</span>
                {label}到此处
              </div>
              <div className="mt-1 text-[11px] text-text-disabled">
                {multiple ? `可一次选择多个${label}，会一起作为素材` : `支持常见${label}格式`}
                <span className="mx-1">·</span>
                单个不超过 {formatSize(MAX_SIZE)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 前置校验提示（类型/大小不合规时） */}
      {notice && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-warning-strong">
          <ExclamationCircleFilled />
          <span>{notice}</span>
          <button
            type="button"
            className="ml-auto shrink-0 text-[10px] underline"
            onClick={() => setNotice('')}
          >
            知道了
          </button>
        </div>
      )}

      {/* ---- 已上传列表（视觉主体）---- */}
      {value.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {value.map((u, i) => (
            <div key={u + i} className="group relative overflow-hidden rounded-lg border border-border bg-surface">
              <div className="relative aspect-[4/3]">
                {kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={toDisplayUrl(u)} alt="" className="size-full object-cover" />
                ) : kind === 'video' ? (
                  <>
                    <video src={toDisplayUrl(u)} muted playsInline preload="metadata" className="size-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 grid place-items-center">
                      <PlayCircleFilled className="text-xl text-white/90 drop-shadow" />
                    </div>
                  </>
                ) : (
                  <div className="flex size-full flex-col items-center justify-center gap-1.5 bg-accent-soft/40">
                    <SoundOutlined className="text-lg text-accent" />
                    <div className="flex items-end gap-[2px]" aria-hidden>
                      {[6, 11, 8, 14, 9, 12, 7].map((h, k) => (
                        <span key={k} className="w-[3px] rounded-full bg-accent/60" style={{ height: h }} />
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="absolute top-1 right-1 grid size-8 place-items-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40"
                  onClick={() => removeAt(i)}
                  disabled={disabled || isUploading}
                  aria-label={`移除这个${label}`}
                >
                  <DeleteOutlined />
                </button>
              </div>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <CheckCircleFilled className="shrink-0 text-[10px] text-success" />
                <span className="min-w-0 flex-1 truncate text-[10px] text-text-secondary">
                  {decodeURIComponent(u.split('/').pop() || `${label} ${i + 1}`)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- 上传中 / 失败（与已完成明确区分）---- */}
      {pending.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {pending.map((p) => (
            <div
              key={p.key}
              className={[
                'overflow-hidden rounded-lg border',
                p.state === 'error' ? 'border-danger/50 bg-danger/5' : 'border-accent-ring/60 bg-accent-soft/30',
              ].join(' ')}
            >
              <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-1.5 px-2 text-center">
                {p.state === 'uploading' && p.previewUrl && kind === 'image' ? (
                  // Q-403：本地 blob 立即预览，转圈收成角标 —— 用户选完立刻看到「传的就是这张」
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" className="size-full object-cover" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/35">
                      <LoadingOutlined className="text-lg text-white" />
                      <span className="line-clamp-1 max-w-full px-1 text-[10px] text-white/90">{p.name}</span>
                      <span className="text-[10px] text-white/70">{formatSize(p.size)}</span>
                    </div>
                  </>
                ) : p.state === 'uploading' && p.previewUrl && kind === 'video' ? (
                  <>
                    <video src={p.previewUrl} muted playsInline preload="metadata" className="size-full object-cover" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/35">
                      <LoadingOutlined className="text-lg text-white" />
                      <span className="line-clamp-1 max-w-full px-1 text-[10px] text-white/90">{p.name}</span>
                      <span className="text-[10px] text-white/70">{formatSize(p.size)}</span>
                    </div>
                  </>
                ) : p.state === 'uploading' ? (
                  <>
                    <LoadingOutlined className="text-lg text-accent" />
                    <span className="line-clamp-2 text-[10px] text-text-secondary">{p.name}</span>
                    <span className="text-[10px] text-text-disabled">{formatSize(p.size)}</span>
                  </>
                ) : (
                  <>
                    <ExclamationCircleFilled className="text-lg text-danger" />
                    <span className="line-clamp-2 text-[10px] text-danger">{p.error || '上传失败'}</span>
                    <span className="line-clamp-1 text-[10px] text-text-disabled">{p.name}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
