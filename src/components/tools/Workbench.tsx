'use client'

import { ImageEditor } from './ImageEditor'

// 工具箱工作台：中间大图预览 + 基础编辑。
// 图片：ImageEditor 全家桶（裁剪/旋转/镜像/涂鸦/马赛克/文字/贴图/画中画/水印/边框/AI 消水印）；
// 视频：区间裁剪 + 字幕烧录 + 变速（canvas + MediaRecorder）；
// 音频：波形 + 片段裁剪/删除/合并 + 人声分离（复用 /api/audio/isolate）。
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Button, Typography, Tooltip, Spin, Modal, Input, Empty } from 'antd'
import {
  ScissorOutlined, CheckOutlined, CloseOutlined, DownloadOutlined,
  LoadingOutlined, AudioOutlined, ReloadOutlined, VideoCameraOutlined,
} from '@ant-design/icons'
import {
  decodeAudioFile, audioBufferToWav, sliceAudio, concatAudio,
  fmtTime,
} from '@/lib/workbench-media'

const { Text } = Typography

export type WorkbenchItem = {
  url: string
  kind: 'image' | 'video' | 'audio'
  label?: string
  /** 编辑产出时的来源 URL（用于回填替换上传槽位里的旧图） */
  fromUrl?: string
}

interface WorkbenchProps {
  item: WorkbenchItem | null
  /**
   * 编辑产出的新成果加入左侧列表。
   *
   * opts.select —— 是否把工作台焦点切到这张新图。默认 true（单张编辑产出）。
   *   九宫格切割一次回传 9 张，必须传 false：否则每张都抢一次焦点，
   *   工作台会疯狂重载、最后停在第 9 张，用户看不到切割结果的全貌。
   */
  onProduced: (item: WorkbenchItem, opts?: { select?: boolean }) => void
  /**
   * 用户在 iframe 内拖入/选中的本地文件（子页 msp:files 转发）。
   *
   * 为什么必须由子页转发：iframe 内部的 drop 事件不会冒泡到父文档，
   * 父页的捕获阶段拖拽处理（onDropCapture）根本收不到 —— 而子页在嵌入模式下
   * 素材库是隐藏的，本地 addFiles 会把图塞进一个用户看不见的列表。
   * 转发后走与「拖到成果区」完全相同的通道，行为一致。
   */
  onExternalFiles?: (files: File[]) => void
  /** 子页拖拽悬停状态（iframe 内 drag 事件不冒泡，需子页转发才能显示落点提示层） */
  onExternalDrag?: (over: boolean) => void
  /**
   * 可写入的图片上传槽（父页从工具 slots 派生）。
   * 工作台工具栏据此显示「用作输入」，点击后把编辑结果直接写进对应槽位。
   */
  inputSlots?: Array<{ id: string; label: string }>
  /**
   * 用户在编辑器里点「用作输入」：回传编辑结果 + 目标槽位。
   * 由父页负责上传换公网地址并写入槽位（与拖拽/面板按钮同一条通道）。
   */
  onUseAsInput?: (slotId: string | null, blob: Blob) => void
  message: { success: (t: string) => void; error: (t: string) => void; warning: (t: string) => void; info: (t: string) => void }
}

export function Workbench({ item, onProduced, onExternalFiles, onExternalDrag, inputSlots, onUseAsInput, message }: WorkbenchProps) {
  if (!item) {
    return (
      <div className="editor-grid grid h-full place-items-center rounded-xl border border-dashed border-accent-ring/60 p-8">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击左侧成果，在此查看与编辑" />
      </div>
    )
  }
  if (item.kind === 'image') {
    return <ImageEditor key={item.url} url={item.url} label={item.label} onProduced={onProduced} message={message} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-black/6 bg-white shadow-sm">
      {item.kind === 'video' && <VideoWorkbench key={`${item.url}-${item.label ?? ''}`} url={item.url} label={item.label} onProduced={onProduced} message={message} inputSlots={inputSlots} onUseAsInput={onUseAsInput} />}
      {item.kind === 'audio' && <AudioWorkbench key={`${item.url}-${item.label ?? ''}`} url={item.url} label={item.label} onProduced={onProduced} message={message} />}
    </div>
  )
}

function VideoWorkbench({ url, label, onProduced, message, inputSlots, onUseAsInput }: { url: string; label?: string } & Omit<WorkbenchProps, 'item'>) {
  const vRef = useRef<HTMLVideoElement>(null)
  const [dur, setDur] = useState(0)
  const [cur, setCur] = useState(0)
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  const [markA, setMarkA] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [meta, setMeta] = useState<{ w: number; h: number } | null>(null)
  const [thumbs, setThumbs] = useState<string[]>([])
  // 字幕（单条：文本 + 显示区间随选区；或全程）
  const [subtitle, setSubtitle] = useState('')
  const [useSelForSub, setUseSelForSub] = useState(true)
  const [subSize, setSubSize] = useState<'sm' | 'md' | 'lg'>('md')
  const [subPos, setSubPos] = useState<'bottom' | 'center' | 'top'>('bottom')
  const [subColor, setSubColor] = useState('#ffffff')
  // 变速
  const [speed, setSpeed] = useState(1)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)

  // 生成胶片缩略图：seek 到均匀分布的 8 个时间点，画到 canvas 取 dataURL。
  // 只在元数据就绪后跑一次；失败静默（缩略图不是必需品，不能拖垮编辑）。
  const buildThumbs = useCallback(async (v: HTMLVideoElement, duration: number) => {
    if (!duration || duration < 0.5) return
    const n = 8
    const cv = document.createElement('canvas')
    const ratio = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9
    cv.width = 160
    cv.height = Math.round(160 / ratio)
    const g = cv.getContext('2d')
    if (!g) return
    const out: string[] = []
    const wasMuted = v.muted
    v.muted = true
    const prevTime = v.currentTime
    for (let i = 0; i < n; i++) {
      const t = (duration * (i + 0.5)) / n
      try {
        await new Promise<void>((res) => {
          const h = () => { v.removeEventListener('seeked', h); res() }
          v.addEventListener('seeked', h)
          v.currentTime = t
          setTimeout(() => { v.removeEventListener('seeked', h); res() }, 1200)
        })
        g.drawImage(v, 0, 0, cv.width, cv.height)
        out.push(cv.toDataURL('image/jpeg', 0.6))
      } catch { /* 单帧失败跳过 */ }
    }
    v.muted = wasMuted
    v.currentTime = prevTime
    if (out.length > 0) setThumbs(out)
  }, [])

  /**
   * 元数据可能**在 React 绑定事件之前就加载完**（本地/小文件尤其明显），
   * 那样 onLoadedMetadata 永远不触发 → dur 恒为 0 → 整个下方面板（剪辑/字幕/导出）
   * 莫名其妙不出现。这里在挂载后主动读一次已就绪的元数据兜底。
   */
  useEffect(() => {
    const v = vRef.current
    if (!v) return
    const hydrate = () => {
      if (!v.duration || !isFinite(v.duration)) return
      setDur((prev) => prev || v.duration)
      setTrimEnd((prev) => prev || v.duration)
      if (v.videoWidth) setMeta((prev) => prev ?? { w: v.videoWidth, h: v.videoHeight })
    }
    hydrate()
    // 还没就绪就等一次 loadedmetadata（两处都调，幂等）
    if (!v.duration) {
      v.addEventListener('loadedmetadata', hydrate, { once: true })
      return () => v.removeEventListener('loadedmetadata', hydrate)
    }
  }, [url])

  return (
    <>
      {/* 顶部信息条：文件名 + 规格 + 下载 */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/5 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><VideoCameraOutlined className="text-[12px]" /></span>
          <Text className="truncate text-[13px] font-medium">{label || '视频工作台'}</Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meta && <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-black/55">{meta.w}×{meta.h}</span>}
          {dur > 0 && <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-black/55">{fmtTime(dur)}</span>}
          <Tooltip title="下载"><a href={url} download target="_blank" rel="noreferrer"><Button size="small" icon={<DownloadOutlined />} /></a></Tooltip>
        </div>
      </div>
      {/*
        播放器：铺满可用空间，视频**完整显示**（不裁切）。

        ===== 为什么不再用 max-h-full（2026-10-20 修）=====
        竖屏视频（如 768×1344）以前会被裁掉底部。原因不是比例算错，而是
        `max-height: 100%` 在**高度不确定的父容器**里会解析成 none ——
        于是视频按宽度撑满，高度溢出，再被外层 overflow-hidden 切掉。
        这在工作台这种「上中下三段 + flex-1」的结构里尤其容易踩到。

        现在改成「视频铺满容器 + object-contain」：
          · 元素尺寸由容器决定（h-full w-full），不再依赖百分比 max-*；
          · object-contain 负责等比缩放并留黑边，**任何比例都完整可见**；
          · 容器给 min-h 兜底，窗口很矮时也不会被压成一条缝。
        这样横屏、竖屏、方形、超宽都不用各写一套规则。
      */}
      <div className="editor-grid relative min-h-[200px] flex-1 overflow-hidden bg-black/[0.03]">
        <video
          ref={vRef} src={url} controls className="absolute inset-3 h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] rounded-lg object-contain shadow-[0_4px_28px_rgba(0,0,0,0.18)]"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            setDur(v.duration || 0)
            setMeta({ w: v.videoWidth, h: v.videoHeight })
            setTrimEnd(v.duration || 0)
            void buildThumbs(v, v.duration || 0)
          }}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        />
      </div>
      {/*
        下方面板最高占 46%，内部滚动。
        不设上限时它会把 flex-1 的播放器挤到几乎没有高度
        （窗口一矮就会出现「视频只剩一条缝」）；设了上限则保证
        播放器永远分到至少一半空间，参数区自己滚动。
      */}
      {dur > 0 && (
        <div className="max-h-[46%] shrink-0 space-y-2.5 overflow-y-auto border-t border-black/5 px-4 py-3 aigc-hub-scrollbar">
          {/* 时间码 + 选区信息 */}
          <div className="flex items-center gap-2 text-[12px] text-black/55">
            <span className="font-mono tabular-nums">{fmtTime(cur)} / {fmtTime(dur)}</span>
            {sel && (
              <>
                <span className="rounded bg-accent-soft px-2 py-0.5 text-accent">已选 {fmtTime(sel.a)} ~ {fmtTime(sel.b)}（{fmtTime(sel.b - sel.a)}）</span>
                <Button size="small" type="text" icon={<CloseOutlined />} className="!px-1" onClick={() => { setSel(null); setMarkA(null) }} />
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {markA === null ? (
                <Button size="small" icon={<ScissorOutlined />} onClick={() => { setMarkA(cur); message.info('起点已标记，拖到结束点再点「设为终点」') }}>设为起点</Button>
              ) : (
                <Button size="small" type="primary" ghost icon={<ScissorOutlined />} onClick={() => { setSel({ a: Math.min(markA, cur), b: Math.max(markA, cur) }); setMarkA(null) }}>设为终点</Button>
              )}
            </div>
          </div>
          {/* 胶片时间轴：缩略图铺底 + 选区高亮 + 播放头；点击跳转 */}
          <div
            className="relative h-12 cursor-pointer overflow-hidden rounded-lg bg-black/8"
            onClick={(e) => {
              const b = e.currentTarget.getBoundingClientRect()
              const t = ((e.clientX - b.left) / b.width) * dur
              if (vRef.current) vRef.current.currentTime = t
              setCur(t)
            }}
          >
            {thumbs.length > 0 && (
              <div className="absolute inset-0 flex">
                {thumbs.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt="" className="h-full flex-1 object-cover opacity-80" draggable={false} />
                ))}
              </div>
            )}
            {sel && (
              <div className="absolute inset-y-0 border-2 border-accent bg-accent/25" style={{ left: `${(sel.a / dur) * 100}%`, width: `${((sel.b - sel.a) / dur) * 100}%` }} />
            )}
            {markA !== null && <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: `${(markA / dur) * 100}%` }} />}
            <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" style={{ left: `${(cur / dur) * 100}%` }} />
          </div>
          {/* 三段式参数面板：剪辑 / 字幕 / 导出 */}
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-black/6 bg-black/[0.015] p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-black/70">剪辑</div>
              <div className="space-y-1.5">
                <label className="flex items-center justify-between gap-2 text-[11px] text-black/55">
                  <span className="shrink-0">变速</span>
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1 rounded border border-black/15 bg-white px-1.5 py-0.5 text-[11px]">
                    {[0.5, 0.75, 1, 1.5, 2].map((s) => <option key={s} value={s}>{s}x</option>)}
                  </select>
                </label>
                <div className="text-[10.5px] leading-snug text-black/40">
                  {sel ? `裁剪 ${fmtTime(sel.b - sel.a)}` : '在时间轴上选起点/终点即可裁剪'}
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-black/6 bg-black/[0.015] p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-black/70">字幕</div>
              <div className="space-y-1.5">
                <Input size="small" placeholder="字幕文字（留空不加）" value={subtitle} maxLength={60} onChange={(e) => setSubtitle(e.target.value)} />
                <div className="flex items-center gap-1.5 text-[11px]">
                  <select value={subSize} onChange={(e) => setSubSize(e.target.value as 'sm' | 'md' | 'lg')} className="flex-1 rounded border border-black/15 bg-white px-1 py-0.5 text-[11px]">
                    <option value="sm">小字</option><option value="md">中字</option><option value="lg">大字</option>
                  </select>
                  <select value={subPos} onChange={(e) => setSubPos(e.target.value as 'bottom' | 'center' | 'top')} className="flex-1 rounded border border-black/15 bg-white px-1 py-0.5 text-[11px]">
                    <option value="bottom">底部</option><option value="center">居中</option><option value="top">顶部</option>
                  </select>
                  <input type="color" value={subColor} onChange={(e) => setSubColor(e.target.value)} className="size-6 shrink-0 cursor-pointer rounded border border-black/15 bg-white" title="字幕颜色" />
                </div>
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-black/55">
                  <input type="checkbox" checked={useSelForSub} onChange={(e) => setUseSelForSub(e.target.checked)} />
                  字幕只在选区内显示
                </label>
              </div>
            </div>
            <div className="flex flex-col rounded-lg border border-black/6 bg-black/[0.015] p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-black/70">导出</div>
              <div className="mb-1.5 flex flex-wrap gap-1">
                {speed !== 1 && <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{speed}x</span>}
                {sel && <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">裁剪</span>}
                {subtitle.trim() && <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">字幕</span>}
                {speed === 1 && !sel && !subtitle.trim() && <span className="text-[10.5px] text-black/40">未做任何修改</span>}
              </div>
              <div className="mt-auto flex flex-col gap-1.5">
                <Button
                  size="small" type="primary" block icon={busy ? <LoadingOutlined /> : <CheckOutlined />}
                  loading={busy}
                  disabled={speed === 1 && !sel && !subtitle.trim()}
                  onClick={async () => {
                    if (!vRef.current) return
                    const a = sel ? sel.a : 0
                    const b = sel ? sel.b : dur
                    setBusy(true)
                    try {
                      const sizeMap = { sm: 0.045, md: 0.062, lg: 0.085 }
                      const blob = await renderVideoEdit(vRef.current, {
                        a, b, speed,
                        subtitle: subtitle.trim()
                          ? { text: subtitle.trim(), a: useSelForSub && sel ? sel.a : 0, b: useSelForSub && sel ? sel.b : dur, size: sizeMap[subSize], pos: subPos, color: subColor }
                          : null,
                      })
                      const newUrl = URL.createObjectURL(blob)
                      const tags: string[] = []
                      if (sel) tags.push('裁剪')
                      if (speed !== 1) tags.push(`${speed}x`)
                      if (subtitle.trim()) tags.push('字幕')
                      onProduced({ url: newUrl, kind: 'video', label: `剪辑${tags.length ? '·' + tags.join('+') : ''}` })
                      message.success('已生成剪辑片段（本地）')
                    } catch (e) { message.error(e instanceof Error ? e.message : '剪辑失败') } finally { setBusy(false) }
                  }}
                >保存片段</Button>
                {onUseAsInput && inputSlots && inputSlots.length > 0 && (
                  <Button
                    size="small" block disabled={speed === 1 && !sel && !subtitle.trim()}
                    onClick={async () => {
                      if (!vRef.current) return
                      const a = sel ? sel.a : 0
                      const b = sel ? sel.b : dur
                      setBusy(true)
                      try {
                        const sizeMap = { sm: 0.045, md: 0.062, lg: 0.085 }
                        const blob = await renderVideoEdit(vRef.current, {
                          a, b, speed,
                          subtitle: subtitle.trim()
                            ? { text: subtitle.trim(), a: useSelForSub && sel ? sel.a : 0, b: useSelForSub && sel ? sel.b : dur, size: sizeMap[subSize], pos: subPos, color: subColor }
                            : null,
                        })
                        onUseAsInput(inputSlots[0].id, blob)
                        message.success(`已用作输入：${inputSlots[0].label}`)
                      } catch (e) { message.error(e instanceof Error ? e.message : '处理失败') } finally { setBusy(false) }
                    }}
                  >用作输入</Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 视频编辑渲染：区间 + 变速 + 字幕烧录（canvas 播放录制，零依赖） */
async function renderVideoEdit(
  video: HTMLVideoElement,
  opts: {
    a: number; b: number; speed: number
    subtitle: { text: string; a: number; b: number; size?: number; pos?: 'bottom' | 'center' | 'top'; color?: string } | null
  },
): Promise<Blob> {
  const cv = document.createElement('canvas')
  cv.width = video.videoWidth
  cv.height = video.videoHeight
  const g = cv.getContext('2d')
  if (!g) throw new Error('canvas 不可用')
  const stream = cv.captureStream(30)
  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('当前浏览器不支持视频录制')
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  const done = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })) })

  video.pause()
  video.playbackRate = opts.speed
  video.currentTime = opts.a
  await new Promise<void>((res) => {
    const h = () => { video.removeEventListener('seeked', h); res() }
    video.addEventListener('seeked', h)
  })
  rec.start()
  video.play()
  await new Promise<void>((res) => {
    const tick = () => {
      g.drawImage(video, 0, 0, cv.width, cv.height)
      const sub = opts.subtitle
      if (sub && video.currentTime >= sub.a && video.currentTime <= sub.b) {
        // 字幕条：字号/位置/颜色由用户选择（size 是相对高度比，默认中字）
        const fs = Math.max(16, cv.height * (sub.size ?? 0.062))
        g.font = `500 ${fs}px "PingFang SC", "Microsoft YaHei", sans-serif`
        const met = g.measureText(sub.text)
        const pad = fs * 0.5
        const bw = Math.min(cv.width - 20, met.width + pad * 2)
        const bh = fs + pad
        const bx = (cv.width - bw) / 2
        const pos = sub.pos ?? 'bottom'
        const by = pos === 'top' ? cv.height * 0.05
          : pos === 'center' ? (cv.height - bh) / 2
          : cv.height - bh - cv.height * 0.05
        g.fillStyle = 'rgba(0,0,0,0.55)'
        g.beginPath()
        g.roundRect(bx, by, bw, bh, 6)
        g.fill()
        g.fillStyle = sub.color ?? '#ffffff'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(sub.text, cv.width / 2, by + bh / 2, bw - pad)
        g.textAlign = 'start'
        g.textBaseline = 'alphabetic'
      }
      if (video.currentTime >= opts.b || video.ended) { video.pause(); res() } else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  rec.stop()
  video.playbackRate = 1
  return done
}

// ============ 音频工作台：波形 + 裁剪/删除/合并 + 人声分离 ============
type Seg = { start: number; end: number }

function AudioWorkbench({ url, label, onProduced, message }: { url: string; label?: string } & Omit<WorkbenchProps, 'item'>) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dur, setDur] = useState(0)
  const [cur, setCur] = useState(0)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [segs, setSegs] = useState<Seg[]>([])
  const [markA, setMarkA] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [isolateOpen, setIsolateOpen] = useState(false)
  const [isolating, setIsolating] = useState(false)
  const [peaks, setPeaks] = useState<number[]>([])

  // 加载解码 + 画波形
  useEffect(() => {
    let alive = true
    decodeAudioFile(url).then((buf) => {
      if (!alive) return
      setBuffer(buf)
      setDur(buf.duration)
      // 降采样峰值
      const data = buf.getChannelData(0)
      const N = 400
      const step = Math.floor(data.length / N) || 1
      const pk: number[] = []
      for (let i = 0; i < N; i++) {
        let m = 0
        for (let j = i * step; j < Math.min((i + 1) * step, data.length); j += 4) m = Math.max(m, Math.abs(data[j]))
        pk.push(m)
      }
      setPeaks(pk)
    }).catch(() => message.error('音频解码失败，仅可播放'))
    return () => { alive = false }
  }, [url, message])

  // 重绘波形（含选区高亮）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const g = cv.getContext('2d')
    if (!g) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth, h = cv.clientHeight
    cv.width = w * dpr; cv.height = h * dpr
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)
    if (peaks.length === 0) return
    const mid = h / 2
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w
      const t = (i / peaks.length) * dur
      const inSel = segs.some((s) => t >= s.start && t < s.end)
      const inMark = markA !== null && ((markA < cur && t >= markA && t < cur) || (markA >= cur && t >= cur && t <= markA))
      g.fillStyle = inSel ? '#7d50e0' : inMark ? '#b48cf2' : 'rgba(0,0,0,0.25)'
      const barH = Math.max(1.5, peaks[i] * (h - 6))
      g.fillRect(x, mid - barH / 2, Math.max(1, w / peaks.length - 0.5), barH)
    }
    if (markA !== null) { g.fillStyle = '#7d50e0'; g.fillRect((markA / dur) * w, 0, 1.5, h) }
    g.fillStyle = 'rgba(0,0,0,0.6)'
    g.fillRect((cur / dur) * w, 0, 1.5, h)
  }, [peaks, segs, cur, dur, markA])

  const seek = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current
    if (!cv || dur === 0) return
    const b = cv.getBoundingClientRect()
    const t = ((e.clientX - b.left) / b.width) * dur
    if (audioRef.current) audioRef.current.currentTime = t
    setCur(t)
  }, [dur])

  const selected = useMemo(() => segs.reduce((s, x) => s + (x.end - x.start), 0), [segs])

  return (
    <>
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-2">
        <Text className="text-[13px] font-medium">{label || '音频工作台'}</Text>
        <div className="flex gap-2">
          <Button size="small" icon={<AudioOutlined />} onClick={() => setIsolateOpen(true)}>人声分离</Button>
          <Tooltip title="下载"><a href={url} download target="_blank" rel="noreferrer"><Button size="small" icon={<DownloadOutlined />} /></a></Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <canvas
          ref={canvasRef}
          className="h-24 w-full max-w-2xl cursor-crosshair rounded-lg bg-black/[0.03]"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); seek(e) }}
          onPointerMove={(e) => { if (e.buttons === 1) seek(e) }}
        />
        {dur > 0 && (
          <div className="flex w-full max-w-2xl items-center gap-2 text-[12px] text-black/55">
            <span className="font-mono">{fmtTime(cur)} / {fmtTime(dur)}</span>
            {selected > 0 && <span className="rounded bg-accent-soft px-2 py-0.5 text-accent">已选 {selected.toFixed(1)}s</span>}
            <div className="ml-auto flex flex-wrap gap-1.5">
              {markA === null ? (
                <Button size="small" onClick={() => setMarkA(cur)}>标记起点</Button>
              ) : (
                <Button size="small" type="primary" onClick={() => { const a = Math.min(markA, cur), b = Math.max(markA, cur); if (b - a > 0.05) setSegs((p) => [...p, { start: a, end: b }]); setMarkA(null) }}>标记终点</Button>
              )}
              {segs.length > 0 && (
                <>
                  <Tooltip title="把选中片段之外的部分去掉（保留选区）">
                    <Button size="small" icon={<ScissorOutlined />} disabled={!!busy} onClick={() => setBusy('keep')}>保留选区</Button>
                  </Tooltip>
                  <Tooltip title="把选中片段删掉（保留其余）">
                    <Button size="small" icon={<CloseOutlined />} disabled={!!busy} onClick={() => setBusy('drop')}>删除片段</Button>
                  </Tooltip>
                </>
              )}
              {segs.length > 0 && <Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => { setSegs([]); setMarkA(null) }}>重选</Button>}
            </div>
          </div>
        )}
        <audio ref={audioRef} src={url} controls className="w-full max-w-2xl"
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration || dur)}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        />
      </div>

      {busy && (
        <AudioEditExecutor
          mode={busy as 'keep' | 'drop'}
          buffer={buffer} segs={segs} url={url}
          onDone={(newUrl, lbl) => { onProduced({ url: newUrl, kind: 'audio', label: lbl }); message.success('已保存到成果区'); setBusy(null) }}
          onErr={(m) => { message.error(m); setBusy(null) }}
        />
      )}

      <Modal
        open={isolateOpen} onCancel={() => setIsolateOpen(false)} footer={null} title="人声分离" width={420}
      >
        <div className="space-y-3 pt-2">
          <Text type="secondary" className="!text-[12px]">
            将当前音频上传到人声分离模型，提取人声音轨。按模型单价扣积分，整段音频处理可能需要一些时间。
          </Text>
          <Button
            type="primary" block icon={isolating ? <LoadingOutlined /> : undefined} loading={isolating}
            onClick={async () => {
              setIsolating(true)
              try {
                const res = await fetch('/api/audio/isolate', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                  body: JSON.stringify({ audioUrl: url }),
                })
                const j = await res.json().catch(() => null)
                if (res.ok && j?.success && j?.data?.url) {
                  onProduced({ url: j.data.url, kind: 'audio', label: '人声分离' })
                  message.success('分离完成，人声音轨已加入成果列表')
                  setIsolateOpen(false)
                } else message.error(j?.message || '人声分离失败')
              } catch { message.error('人声分离失败，请检查网络') } finally { setIsolating(false) }
            }}
          >开始分离</Button>
        </div>
      </Modal>
    </>
  )
}

/** 执行「保留选区 / 删除片段」的导出动作（挂载即跑，完成回调） */
function AudioEditExecutor({ mode, buffer, segs, url, onDone, onErr }: {
  mode: 'keep' | 'drop'
  buffer: AudioBuffer | null
  segs: Seg[]
  url: string
  onDone: (url: string, label: string) => void
  onErr: (m: string) => void
}) {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        let out: AudioBuffer
        const sorted = [...segs].sort((a, b) => a.start - b.start)
        if (!buffer) throw new Error('音频尚未解码完成')
        if (mode === 'keep') {
          out = concatAudio(sorted.map((s) => sliceAudio(buffer, s.start, s.end)))
        } else {
          // drop：取选区之外的片段
          const parts: Seg[] = []
          let pos = 0
          for (const s of sorted) { if (s.start - pos > 0.02) parts.push({ start: pos, end: s.start }); pos = Math.max(pos, s.end) }
          if (buffer.duration - pos > 0.02) parts.push({ start: pos, end: buffer.duration })
          out = parts.length > 0 ? concatAudio(parts.map((s) => sliceAudio(buffer, s.start, s.end))) : buffer
        }
        const blob = audioBufferToWav(out)
        // 音频编辑产出同样留在浏览器本地，需要当输入时按需上传
        const newUrl = URL.createObjectURL(blob)
        onDone(newUrl, mode === 'keep' ? '保留选区' : '删除片段')
      } catch (e) { onErr(e instanceof Error ? e.message : '音频编辑失败') }
    })()
  }, [mode, buffer, segs, url, onDone, onErr])
  return <Spin tip="处理中…" className="fixed inset-0 z-1000 grid place-items-center bg-white/40" />
}
