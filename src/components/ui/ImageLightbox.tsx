'use client'

/**
 * 图片放大查看（自带缩放，不依赖浏览器默认行为）。
 *
 * ===== 为什么自己做，而不是用 antd 的 Image.PreviewGroup =====
 * 用户反馈：看到图想放大看，但「可能是浏览器的限制，不支持直接点击放大」。
 * antd 的 Image 预览虽然能做，但：
 *   1) 它要求把 <img> 换成 antd 的 <Image>，会破坏 Markdown 渲染出的原生 img 结构；
 *   2) 它的默认视觉是白底大弹窗，和面板的克制风格不一致；
 *   3) 在**窄面板 + 移动端**里它的缩放/拖拽体验不可控。
 * 所以自建一个最小的灯箱：**缩放（+/−/滚轮/双击）、拖拽平移、切换前后张**都自己管，
 * 行为确定、可预测。
 *
 * ===== 交互（对齐用户诉求「悬停出现查看/放大按钮」） =====
 * - 触发方式由调用方决定（通常包一个 hover 出按钮的容器）
 * - 打开后可：滚轮缩放、双击还原、拖拽平移、左右切换、Esc 关闭
 * - 缩放范围 0.2x ~ 8x；打开时按容器自适应到「刚好放得下」
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Modal, Button } from 'antd'
import { ZoomInOutlined, ZoomOutOutlined, LeftOutlined, RightOutlined, ExpandOutlined, CloseOutlined, DownloadOutlined, CopyOutlined } from '@ant-design/icons'
import { downloadResults } from '@/lib/download-results'
import { copyMediaToClipboard } from '@/lib/media-clipboard'

export interface ImageLightboxProps {
  open: boolean
  /** 图片列表（支持多张时左右切换） */
  urls: string[]
  /** 初始显示第几张（默认 0） */
  startIndex?: number
  onClose: () => void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 8

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

function pointerDistance(points: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...points.values()]
  if (!a || !b) return 0
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function ImageLightbox({ open, urls, startIndex = 0, onClose }: ImageLightboxProps) {
  const { message } = App.useApp()
  const [idx, setIdx] = useState(startIndex)
  const [scale, setScale] = useState(1)
  // 拖拽平移（缩放后看图角时必需 —— 否则放大后四周看不见、又拖不动）
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null)
  const swipeRef = useRef<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // 每次打开重置视图（否则会带着上一次的缩放/位移，看起来像"图没加载出来"）
  useEffect(() => {
    if (open) {
      setIdx(Math.min(Math.max(startIndex, 0), Math.max(urls.length - 1, 0)))
      setScale(1)
      setPos({ x: 0, y: 0 })
      pointersRef.current.clear()
      pinchRef.current = null
      swipeRef.current = null
      dragRef.current = null
      setDragging(false)
    }
  }, [open, startIndex, urls.length])

  const zoom = useCallback((delta: number) => {
    setScale((s) => {
      const next = clampScale(s + delta)
      // 缩回 1 以下时把位移归零，避免图被拖到视野外找不回来
      if (next <= 1) setPos({ x: 0, y: 0 })
      return next
    })
  }, [])

  const reset = useCallback(() => { setScale(1); setPos({ x: 0, y: 0 }) }, [])

  const go = useCallback((d: number) => {
    setIdx((i) => {
      const n = i + d
      if (urls.length <= 1) return i
      return (n + urls.length) % urls.length
    })
    reset()
  }, [urls.length, reset])

  // 键盘：Esc 关闭 / ←→ 切换 / +− 缩放（键盘用户也要能用）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === '+' || e.key === '=') zoom(0.25)
      else if (e.key === '-') zoom(-0.25)
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, go, zoom, reset])

  const url = urls[idx]

  const download = async () => {
    if (!url) return
    const { ok, failed } = await downloadResults([{ url, kind: 'image', name: '图片' }])
    if (ok > 0) message.success('已开始下载')
    else if (failed > 0) message.error('下载失败（链接可能已过期）')
  }

  const copy = async () => {
    if (!url) return
    try {
      const res = await copyMediaToClipboard(url, 'image')
      message.success(res.message)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '复制失败')
    }
  }

  const endPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const wasSingle = pointersRef.current.size === 1
    const start = swipeRef.current
    const dx = start ? e.clientX - start.x : 0
    const dy = start ? e.clientY - start.y : 0
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) {
      dragRef.current = null
      swipeRef.current = null
      setDragging(false)
      if (wasSingle && scale <= 1 && Math.abs(dx) > 60 && Math.abs(dy) < 45) {
        go(dx > 0 ? -1 : 1)
      }
    }
  }, [go, scale])

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      closable={false}
      width="min(1500px, 96vw)"
      destroyOnHidden
      style={{ top: 12, paddingBottom: 12 }}
      // 灯箱自带暗底：让 Modal 容器透明（antd 6 的语义 key 是 container/body，
      // 没有 content —— 写 content 会直接类型报错）
      styles={{
        body: { padding: 0, background: 'transparent', maxHeight: 'calc(100dvh - 24px)', overflow: 'hidden' },
        container: { background: 'transparent', boxShadow: 'none' },
      }}
    >
      <div className="relative flex max-h-[calc(100dvh-24px)] select-none flex-col">
        <button
          type="button"
          aria-label="关闭预览"
          title="关闭预览（Esc）"
          onClick={onClose}
          className="absolute right-2 top-2 z-30 grid size-10 place-items-center rounded-full border border-white/20 bg-black/65 text-white shadow-lg backdrop-blur transition hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          style={{ top: 'max(8px, env(safe-area-inset-top))' }}
        >
          <CloseOutlined />
        </button>

        {/* 图片区：滚轮缩放 + 拖拽平移 */}
        <div
          className="relative flex min-h-[280px] flex-1 touch-none items-center justify-center overflow-hidden rounded-xl bg-black/90"
          style={{ height: 'min(84dvh, 900px)', cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in' }}
          onWheel={(e) => {
            // 阻止页面跟着滚（面板里滚轮很敏感）
            e.preventDefault()
            zoom(e.deltaY < 0 ? 0.2 : -0.2)
          }}
          onDoubleClick={() => (scale > 1 ? reset() : setScale(2))}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
            if (pointersRef.current.size === 1) {
              swipeRef.current = { x: e.clientX, y: e.clientY }
              if (scale > 1) {
                dragRef.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }
                setDragging(true)
              }
            } else if (pointersRef.current.size === 2) {
              pinchRef.current = { distance: pointerDistance(pointersRef.current), scale }
              dragRef.current = null
              setDragging(false)
            }
          }}
          onPointerMove={(e) => {
            if (!pointersRef.current.has(e.pointerId)) return
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
            const pinch = pinchRef.current
            if (pinch && pointersRef.current.size >= 2) {
              const distance = pointerDistance(pointersRef.current)
              if (pinch.distance <= 0) return
              const next = clampScale(pinch.scale * (distance / pinch.distance))
              setScale(next)
              if (next <= 1) setPos({ x: 0, y: 0 })
              return
            }
            const d = dragRef.current
            if (d && scale > 1) setPos({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) })
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt="预览"
              draggable={false}
              className="max-h-full max-w-full object-contain transition-transform duration-75"
              style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
              onLoad={(e) => {
                const el = e.currentTarget as HTMLImageElement
                el.style.display = ''
                const tip = el.parentElement?.querySelector('[data-img-tip]') as HTMLElement | null
                if (tip) tip.style.display = 'none'
              }}
              onError={(e) => {
                // 上游链接会过期 → 破图时给可读提示，而不是留一个空白弹窗
                const el = e.currentTarget as HTMLImageElement
                el.style.display = 'none'
                const tip = el.parentElement?.querySelector('[data-img-tip]') as HTMLElement | null
                if (tip) tip.style.display = 'flex'
              }}
            />
          )}
          <div data-img-tip style={{ display: 'none' }} className="absolute inset-0 flex-col items-center justify-center gap-2 text-center">
            <span className="text-sm text-white/90">图片加载失败，链接可能已过期</span>
            <span className="text-xs text-white/60">上游临时链接通常几小时到几天失效，请尽快下载保存</span>
          </div>
        </div>

        {/* 工具条：缩放 / 还原 / 切换 */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 px-2 pb-[env(safe-area-inset-bottom)]">
          <Button size="small" icon={<ZoomOutOutlined />} onClick={() => zoom(-0.25)} title="缩小（-）" aria-label="缩小">
            <span className="max-sm:hidden">缩小</span>
          </Button>
          <span className="min-w-[52px] text-center text-xs tabular-nums text-white/80">{Math.round(scale * 100)}%</span>
          <Button size="small" icon={<ZoomInOutlined />} onClick={() => zoom(0.25)} title="放大（+）" aria-label="放大">
            <span className="max-sm:hidden">放大</span>
          </Button>
          <Button size="small" icon={<ExpandOutlined />} onClick={reset} title="还原（0）" aria-label="还原">
            <span className="max-sm:hidden">还原</span>
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => void download()} title="下载" aria-label="下载">
            <span className="max-sm:hidden">下载</span>
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()} title="复制" aria-label="复制">
            <span className="max-sm:hidden">复制</span>
          </Button>
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} title="关闭（Esc）" aria-label="关闭预览">
            关闭
          </Button>
          {urls.length > 1 && (
            <>
              <span className="mx-1 text-xs text-white/60">{idx + 1}/{urls.length}</span>
              <Button size="small" icon={<LeftOutlined />} onClick={() => go(-1)} title="上一张（←）" aria-label="上一张" />
              <Button size="small" icon={<RightOutlined />} onClick={() => go(1)} title="下一张（→）" aria-label="下一张" />
            </>
          )}
        </div>
        <div className="mt-1.5 hidden text-center text-[11px] text-white/45 sm:block">
          滚轮缩放 · 双击还原 · 放大后可拖动图片 · Esc 关闭
        </div>
        <div className="mt-1.5 text-center text-[11px] text-white/45 sm:hidden">
          双指缩放 · 单指拖动 · 左右滑动切换
        </div>
      </div>
    </Modal>
  )
}
