'use client'

import { useState, useRef, useEffect } from 'react'
import { Button, Select, Tooltip, App, Modal, Dropdown } from 'antd'
import { MenuProps } from 'antd'
import { PlayCircleOutlined, PauseOutlined, CopyOutlined, CheckOutlined, DownloadOutlined, ExpandOutlined, ScissorOutlined, ThunderboltOutlined, RetweetOutlined, SmileOutlined, VideoCameraOutlined, EyeOutlined } from '@ant-design/icons'
import { decodeSize } from '@/lib/image-sizes'
import { effectivePoints } from '@/lib/pricing'
import { resolveTierCost } from '@/lib/billing/billing-plans'
import { downloadResults } from '@/lib/download-results'
import { copyMediaToClipboard } from '@/lib/media-clipboard'
import { NodeBodyCtx } from './types'

// ===== 节点标注：左上角液态玻璃小标签（浮在结果之上）=====
export function ResultLabel({ text, color }: { text: string; color?: string }) {
  return (
    <span
      className="pointer-events-none absolute left-2 top-2 z-10 rounded-full border border-white/50 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur-md"
      style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))', backgroundColor: `${color ?? '#7d50e0'}99` }}
    >
      {text}
    </span>
  )
}

// 模型选择：固定宽度保证各节点参数条布局统一；下拉选项末尾显示积分消耗
export function ModelSelect({
  ctx,
  wantTypes,
  wantKinds,
  width = 200,
  onAfterChange,
}: {
  ctx: NodeBodyCtx
  wantTypes: string[]
  wantKinds?: string[]
  width?: number
  onAfterChange?: (id: string) => void
}) {
  const current = ctx.node.inputs.model as string | undefined
  const filtered = ctx.modelOptions.filter(
    (m) => wantTypes.includes(m.type) && (!wantKinds || wantKinds.includes((m.metadata?.kind as string) || ''))
  )
  const options = filtered.map((m) => {
    const raw = m as { costPoints?: number | null; effectiveCostPoints?: number | null; pricingType?: string; isFree?: boolean; dailyUserFreeQuota?: number | null; freeQuotaRemaining?: number | null; promoFreeImage?: boolean }
    let costLabel = ''
    if ((raw.dailyUserFreeQuota ?? 0) > 0 || raw.promoFreeImage) costLabel = ' · 免费使用'
    else if (raw.isFree) costLabel = ' · 免费'
    else if (raw.pricingType === 'PER_TOKEN') costLabel = ' · 按量'
    else {
      const c = raw.effectiveCostPoints ?? raw.costPoints
      if (typeof c === 'number' && c > 0) costLabel = ` · ${c}分`
    }
    return { value: m.id, label: `${m.name}${costLabel}` }
  })
  return (
    <div className="shrink-0" style={{ width }} onPointerDown={ctx.stopPropagation}>
      <Select
        size="small"
        variant="borderless"
        className="w-full text-xs"
        value={current || undefined}
        onChange={(v) => {
          ctx.onUpdateInput(ctx.node.id, 'model', v)
          onAfterChange?.(v)
        }}
        placeholder="选择模型"
        options={options}
        dropdownStyle={{ minWidth: 200 }}
      />
    </div>
  )
}

// 预估消耗积分：折后价优先；按次计价时按节点所选尺寸档位取 tierCost（含折扣取整，与后端结算同口径）；
// 按 Token 计价模型无法预知单次消耗 → 显示「按量计费」
export function CostChip({ ctx }: { ctx: NodeBodyCtx }) {
  const current = ctx.node.inputs.model as string | undefined
  const selected = ctx.modelOptions.find((m) => m.id === current)
  const raw = selected as { costPoints?: number | null; effectiveCostPoints?: number | null; pricingType?: string; isFree?: boolean; discount?: number | null; metadata?: Record<string, unknown> | null; dailyUserFreeQuota?: number | null; freeQuotaRemaining?: number | null; promoFreeImage?: boolean } | undefined
  if (!raw) return null
  if ((raw.dailyUserFreeQuota ?? 0) > 0 || raw.promoFreeImage) {
    return (
      <span className="shrink-0 whitespace-nowrap rounded-full border border-success/30 bg-success-bg/80 px-1.5 py-0.5 text-[10px] font-medium text-success" title="该模型可免费使用">
        免费使用
      </span>
    )
  }
  if (raw.isFree) {
    return (
      <span className="shrink-0 whitespace-nowrap rounded-full border border-success/30 bg-success-bg/80 px-1.5 py-0.5 text-[10px] font-medium text-success" title="该模型免费">
        免费
      </span>
    )
  }
  if (raw.pricingType === 'PER_TOKEN') {
    return (
      <span className="shrink-0 whitespace-nowrap rounded-full border border-warning/40 bg-warning-bg/80 px-1.5 py-0.5 text-[10px] font-medium text-warning-strong" title="按 Token 计费，实际消耗以运行结果为准">
        按量计费
      </span>
    )
  }
  // 按次计费：按节点所选尺寸档位取价（未单独定价的档位沿用 1K 参考价），与后端同口径
  let cost: number | null = raw.effectiveCostPoints ?? raw.costPoints ?? null
  const w = Number(ctx.node.inputs.width) || 0
  const h = Number(ctx.node.inputs.height) || 0
  if (w > 0 && h > 0) {
    const decoded = decodeSize(`${w}x${h}`)
    cost = effectivePoints(
      resolveTierCost(
        { costPoints: raw.costPoints ?? 0, discount: raw.discount, isFree: false, metadata: raw.metadata ?? null },
        decoded?.tier,
      ),
      raw.discount,
      false,
    )
  }
  if (typeof cost !== 'number' || cost <= 0) return null
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full border border-accent/25 bg-accent-light/70 px-1.5 py-0.5 text-[10px] font-medium text-accent" title="预估消耗积分">
      预估 {cost} 分
    </span>
  )
}

export function RunButton({ ctx }: { ctx: NodeBodyCtx }) {
  return (
    <Tooltip title="运行工作流">
      <Button
        type="primary"
        size="small"
        icon={<PlayCircleOutlined />}
        loading={ctx.running}
        onClick={(e) => { e.stopPropagation(); ctx.onRun() }}
        onPointerDown={ctx.stopPropagation}
        className="shrink-0"
      />
    </Tooltip>
  )
}

// 结果文本：铺满可滚动 + 复制按钮 + 大屏查看（通用结果区与文本类卡身共用）
export function TextResult({ text }: { text: string }) {
  const { message } = App.useApp()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div className="relative">
        <div className="absolute right-1.5 top-1.5 z-10 flex flex-col gap-1">
          <button
            type="button"
            title="复制全文"
            onClick={async (e) => {
              e.stopPropagation()
              try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { message.error('复制失败') }
            }}
            className="grid size-6 place-items-center rounded-full bg-black/45 text-white shadow-sm backdrop-blur transition-colors hover:bg-black/65"
          >
            {copied ? <CheckOutlined className="text-[10px] text-success" /> : <CopyOutlined className="text-[10px]" />}
          </button>
          <button
            type="button"
            title="大屏查看"
            onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
            className="grid size-6 place-items-center rounded-full bg-black/45 text-white shadow-sm backdrop-blur transition-colors hover:bg-black/65"
          >
            <ExpandOutlined className="text-[10px]" />
          </button>
        </div>
        <div className="aigc-hub-scrollbar max-h-[480px] min-h-[80px] overflow-y-auto whitespace-pre-wrap break-all bg-surface/60 px-3 py-2 text-xs leading-relaxed text-foreground">
          {text}
        </div>
      </div>
      {/* 大屏模态：portal 到 body（卡身 overflow-hidden + 世界容器 transform 会捕获 fixed 定位） */}
      {expanded && (
        <Modal
          open
          onCancel={() => setExpanded(false)}
          footer={null}
          width={896}
          centered
          title="全文查看"
        >
          <pre className="max-h-[70vh] overflow-y-auto aigc-hub-scrollbar whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{text}</pre>
        </Modal>
      )}
    </>
  )
}

// 媒体结果悬浮按钮组：衍生创作 / 保存本地 / 复制 / 放大查看
export function MediaActions({
  src,
  kind,
  onPreview,
  onDerive,
}: {
  src: string
  kind: 'image' | 'video' | 'audio'
  onPreview: (src: string) => void
  onDerive?: (type: 'remix' | 'face-doodle' | 'animate' | 'crop' | 'vision' | 'upscale') => void
}) {
  const { message } = App.useApp()
  const [copied, setCopied] = useState(false)
  const btn = 'grid size-7 place-items-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70'

  const deriveItems: MenuProps['items'] = [
    {
      key: 'remix',
      icon: <RetweetOutlined className="text-accent" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">同款变体 (Remix)</span>
          <span className="text-[10px] text-text-muted">保持构图生成同风格微调变体</span>
        </div>
      ),
    },
    {
      key: 'face-doodle',
      icon: <SmileOutlined className="text-warning-strong" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">漫剧过脸 (Face Doodle)</span>
          <span className="text-[10px] text-text-muted">人脸智能涂鸦与漫改换装</span>
        </div>
      ),
    },
    {
      key: 'animate',
      icon: <VideoCameraOutlined className="text-info" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">动效生视频 (Animate)</span>
          <span className="text-[10px] text-text-muted">以当前图为首帧生成运镜视频</span>
        </div>
      ),
    },
    {
      key: 'crop',
      icon: <ScissorOutlined className="text-success" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">智能裁剪 (Crop)</span>
          <span className="text-[10px] text-text-muted">自由裁切或四/九宫格分割</span>
        </div>
      ),
    },
    {
      key: 'vision',
      icon: <EyeOutlined className="text-primary" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">AI 视觉解读 (Vision)</span>
          <span className="text-[10px] text-text-muted">深度画面分析与 Prompt 反推</span>
        </div>
      ),
    },
    {
      key: 'upscale',
      icon: <ThunderboltOutlined className="text-amber-500" />,
      label: (
        <div className="flex flex-col py-0.5">
          <span className="text-xs font-medium text-foreground">超分重绘 (Upscale)</span>
          <span className="text-[10px] text-text-muted">4K/8K 极致高清细节增强</span>
        </div>
      ),
    },
  ]

  const copy = async () => {
    try {
      const res = await copyMediaToClipboard(src, kind)
      message.success(res.message)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch (err) { message.error(err instanceof Error ? err.message : '复制失败') }
  }
  const download = async () => {
    const { ok, failed } = await downloadResults([{
      url: src,
      kind,
      name: kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频',
    }])
    if (ok > 0) message.success('已开始下载')
    else if (failed > 0) message.error('下载失败（链接可能已过期）')
  }
  return (
    <div className="absolute right-1.5 top-1.5 z-10 flex flex-col gap-1.5">
      {kind === 'image' && onDerive && (
        <Dropdown
          menu={{
            items: deriveItems,
            onClick: ({ key }) => onDerive(key as 'remix' | 'face-doodle' | 'animate' | 'crop' | 'vision' | 'upscale'),
          }}
          placement="bottomRight"
          trigger={['click']}
        >
          <button
            type="button"
            title="一键衍生创作"
            onClick={(e) => e.stopPropagation()}
            className={`${btn} ring-1 ring-white/30 hover:bg-accent/80 hover:ring-accent`}
          >
            <ThunderboltOutlined className="text-xs text-amber-300 animate-pulse" />
          </button>
        </Dropdown>
      )}
      <button type="button" title="保存到本地" onClick={(e) => { e.stopPropagation(); void download() }} className={btn}><DownloadOutlined className="text-xs" /></button>
      <button type="button" title={copied ? '已复制' : '复制'} onClick={(e) => { e.stopPropagation(); void copy() }} className={btn}>
        {copied ? <CheckOutlined className="text-xs text-success" /> : <CopyOutlined className="text-xs" />}
      </button>
      <button type="button" title="放大查看" onClick={(e) => { e.stopPropagation(); onPreview(src) }} className={btn}><ExpandOutlined className="text-xs" /></button>
    </div>
  )
}

// =====================================================================
// 卡身（结果重放区）：节点本体 = 90%+ 结果 + 左上角标注
// =====================================================================

// 音波占位组件：给音频节点一个「大面板 + 高占用」的视觉底，避免小框套小框
export function AudioWave({ center, className = '' }: { center?: React.ReactNode; className?: string }) {
  const bars = Array.from({ length: 36 }, (_, i) => 25 + ((i * 37) % 55))
  return (
    <div className={`relative flex w-full items-center justify-center overflow-hidden ${className}`}>
      <div className="flex h-full w-full items-center justify-center gap-[3px]">
        {bars.map((h, i) => (
          <div
            key={i}
            className="w-[3px] rounded-full bg-gradient-to-t from-accent/40 to-accent/80"
            style={{ height: `${h}%`, animation: `audioWave 1.4s ease-in-out ${(i % 9) * 0.12}s infinite` }}
          />
        ))}
      </div>
      {center && <div className="absolute inset-0 flex items-center justify-center">{center}</div>}
    </div>
  )
}

// 音频播放条：音波可视化 + 播放/暂停 + 进度/时长（替代原生 <audio controls>，运行后也保留音波 UI）
export function WavePlayer({ src, compact = false }: { src: string; compact?: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dur, setDur] = useState(0)
  // 当前播放时间：由 timeupdate 事件同步进 state（渲染期读 ref 会触发 react-hooks/refs）
  const [curTime, setCurTime] = useState(0)

  useEffect(() => {
    const a = ref.current
    if (!a) return
    const onTime = () => { setCurTime(a.currentTime || 0); setProgress((a.currentTime || 0) / (a.duration || 1)) }
    const onMeta = () => setDur(a.duration || 0)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => { setPlaying(false); setProgress(0); setCurTime(0); try { a.currentTime = 0 } catch { /* */ } }
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('timeupdate', onTime); a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); a.removeEventListener('ended', onEnd)
    }
  }, [ref])

  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) a.play().catch(() => setPlaying(false))
    else a.pause()
  }

  const fmt = (s: number) => {
    if (!isFinite(s) || s <= 0) return '0:00'
    const m = Math.floor(s / 60), sec = Math.floor(s % 60)
    return `${m}:${sec < 10 ? '0' : ''}${sec}`
  }

  const bars = compact ? Array.from({ length: 24 }, (_, i) => 30 + ((i * 31) % 50)) : Array.from({ length: 36 }, (_, i) => 25 + ((i * 37) % 55))

  return (
    <div className={`wave-player relative w-full overflow-hidden rounded-lg border border-accent-border/50 bg-accent-soft/40 ${compact ? 'h-9' : 'h-14'}`}>
      <audio ref={ref} src={src} preload="metadata" className="hidden" />
      {/* 音波底（播放时静止，进度用渐变覆盖显示进度） */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[3px] px-9">
        {bars.map((h, i) => (
          <div
            key={i}
            className="w-[3px] rounded-full bg-accent/30"
            style={{ height: `${compact ? h * 0.5 + 20 : h}%`, transform: `scaleY(${playing ? 0.5 + Math.abs(Math.sin((i / bars.length) * Math.PI * 2 + progress * Math.PI * 4)) * 0.5 : 1})`, transition: 'transform .1s linear' }}
          />
        ))}
      </div>
      {/* 进度遮罩：已播放部分高亮（从左侧按百分比切） */}
      <div className="pointer-events-none absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${progress * 100}%`, zIndex: 1 }} />
      {/* 播放按钮 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle() }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-2 top-1/2 -translate-y-1/2 z-10 grid size-7 place-items-center rounded-full bg-accent/90 text-white shadow-md transition-transform hover:scale-105 active:scale-95"
        title={playing ? '暂停' : '播放'}
      >
        {playing ? <PauseOutlined className="text-[11px]" /> : <PlayCircleOutlined className="text-[12px]" />}
      </button>
      {/* 播放进度 + 时长（右侧） */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1 rounded-md bg-black/30 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur">
        <span>{fmt(curTime)}</span>
        <span className="text-white/50">/</span>
        <span>{fmt(dur)}</span>
      </div>
    </div>
  )
}
