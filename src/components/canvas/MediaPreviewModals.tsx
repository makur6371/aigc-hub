'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Modal, Segmented } from 'antd'
import { EyeOutlined, SwapOutlined, CloseOutlined } from '@ant-design/icons'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'

// ===== 媒体放大预览：图片 / 视频 =====
//
// 从 canvas/page.tsx（4100+ 行）抽出：这两个预览 Modal 原本内联在巨型文件里，
// 与画布交互状态完全无关（只依赖两个 URL 状态），是最适合先抽的内聚块。
//
// 为什么抽出来：
//   1) 巨型文件每减少一块，后续拆分与阅读都更容易；
//   2) 预览逻辑集中后，图片/视频的**失败兜底可以统一** ——
//      原先图片 onError 会回落到 placeholder，而视频没有兜底（抽离时一并补齐）。

interface Props {
  /** 要预览的图片 URL（null = 不显示） */
  image: string | null
  /** 对比原图 URL（可选，提供时激活 Before/After 卷帘对比） */
  compareImage?: string | null
  /** 要预览的视频 URL（null = 不显示） */
  video: string | null
  onCloseImage: () => void
  onCloseVideo: () => void
}

export function MediaPreviewModals({ image, compareImage, video, onCloseImage, onCloseVideo }: Props) {
  const [mode, setMode] = useState<'single' | 'split' | 'side'>('single')
  const [sliderPos, setSliderPos] = useState(50) // 0~100 百分比
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 当传入对比原图时，默认切到对比卷帘模式
  useEffect(() => {
    if (compareImage && image) {
      setMode('split')
    } else {
      setMode('single')
    }
  }, [compareImage, image])

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!isDragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
    setSliderPos(pct)
  }, [isDragging])

  const handlePointerUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      return () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }
    }
  }, [isDragging, handlePointerMove, handlePointerUp])

  return (
    <>
      <Modal
        open={!!image}
        onCancel={onCloseImage}
        footer={null}
        width={mode === 'side' ? 1400 : 1100}
        centered
        destroyOnHidden
        styles={{ body: { padding: 0, position: 'relative', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto' } }}
        closeIcon={null}
      >
        <div className="relative flex flex-col items-center select-none">
          {/* 固定关闭按钮：内容再高、移动端滚动时也一定能关掉 */}
          <button
            type="button"
            aria-label="关闭预览"
            title="关闭预览"
            onClick={onCloseImage}
            className="fixed right-3 z-[1200] grid size-10 place-items-center rounded-full border border-white/20 bg-black/65 text-white shadow-lg backdrop-blur transition hover:bg-black/85"
            style={{ top: 'max(12px, env(safe-area-inset-top))' }}
          >
            <CloseOutlined />
          </button>
          {/* 顶部控制悬浮胶囊 */}
          <div className="mb-3 z-30 flex items-center gap-2 rounded-full glass-panel border border-white/20 px-3 py-1.5 shadow-2xl backdrop-blur-xl">
            {compareImage && (
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => setMode(v as 'single' | 'split' | 'side')}
                options={[
                  { label: '卷帘对比', value: 'split', icon: <SwapOutlined /> },
                  { label: '左右对照', value: 'side', icon: <EyeOutlined /> },
                  { label: '单图查看', value: 'single' },
                ]}
              />
            )}
          </div>

          {/* 图像显示核心容器 */}
          {image && (
            mode === 'split' && compareImage ? (
              // 卷帘对比视图 (Before / After Split Slider)
              <div
                ref={containerRef}
                className="relative max-h-[82vh] w-fit max-w-[90vw] overflow-hidden rounded-xl border border-white/20 shadow-2xl bg-black/40 cursor-ew-resize"
                onPointerDown={handlePointerDown}
              >
                {/* 底层：处理后产物（After / Result） */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image}
                  alt="After"
                  draggable={false}
                  className="block max-h-[82vh] max-w-[90vw] object-contain"
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement
                    if (!el.src.endsWith('/placeholder.png')) el.src = '/placeholder.png'
                  }}
                />

                {/* 顶层裁切层：原始参考图（Before / Source） */}
                <div
                  className="absolute inset-y-0 left-0 overflow-hidden pointer-events-none"
                  style={{ width: `${sliderPos}%` }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={compareImage}
                    alt="Before"
                    draggable={false}
                    className="block max-h-[82vh] max-w-[90vw] object-contain"
                    onError={(e) => {
                      const el = e.currentTarget as HTMLImageElement
                      if (!el.src.endsWith('/placeholder.png')) el.src = '/placeholder.png'
                    }}
                  />
                </div>

                {/* 卷帘分割线与手柄 */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_10px_rgba(0,0,0,0.8)] pointer-events-none z-10"
                  style={{ left: `${sliderPos}%` }}
                >
                  <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-8 rounded-full bg-white/95 text-black flex items-center justify-center shadow-lg border border-black/10">
                    <SwapOutlined className="text-xs" />
                  </div>
                </div>

                {/* 标签提示 */}
                <div className="pointer-events-none absolute left-3 bottom-3 z-10 rounded bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                  原图 / 参考
                </div>
                <div className="pointer-events-none absolute right-3 bottom-3 z-10 rounded bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                  重绘 / 产物
                </div>
              </div>
            ) : mode === 'side' && compareImage ? (
              // 左右分栏对照视图 (Side-by-Side)
              <div className="grid grid-cols-2 gap-4 max-h-[82vh] max-w-[95vw] rounded-xl border border-white/20 p-2 shadow-2xl bg-black/40 backdrop-blur-md">
                <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-lg bg-black/20">
                  <span className="absolute top-2 left-2 z-10 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white">原图 / 参考</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={compareImage} alt="Before" className="max-h-[76vh] object-contain" />
                </div>
                <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-lg bg-black/20">
                  <span className="absolute top-2 left-2 z-10 rounded bg-black/60 px-2 py-0.5 text-[10px] text-accent">重绘 / 产物</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image} alt="After" className="max-h-[76vh] object-contain" />
                </div>
              </div>
            ) : (
              // 单图普通视图
              <div className="relative max-h-[82vh] max-w-[90vw] overflow-hidden rounded-xl border border-white/20 shadow-2xl bg-black/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image}
                  alt="预览"
                  className="block max-h-[82vh] max-w-[90vw] object-contain"
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement
                    if (!el.src.endsWith('/placeholder.png')) el.src = '/placeholder.png'
                  }}
                />
              </div>
            )
          )}
          <div className="mt-3 w-full max-w-[90vw]">
            <MediaActionsBar url={image} kind="image" name="图片" onClose={onCloseImage} align="center" />
          </div>
        </div>
      </Modal>

      <Modal
        open={!!video}
        onCancel={onCloseVideo}
        footer={null}
        width={1000}
        centered
        destroyOnHidden
        styles={{ body: { padding: 0, maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto' } }}
      >
        <button
          type="button"
          aria-label="关闭视频预览"
          title="关闭视频预览"
          onClick={onCloseVideo}
          className="fixed right-3 z-[1200] grid size-10 place-items-center rounded-full border border-white/20 bg-black/65 text-white shadow-lg backdrop-blur transition hover:bg-black/85"
          style={{ top: 'max(12px, env(safe-area-inset-top))' }}
        >
          <CloseOutlined />
        </button>
        {/* 视频同图片一样需要兜底：链接过期时给出可读提示，而不是空白弹窗 */}
        {video && (
          <video
            src={video}
            controls
            autoPlay
            className="w-full max-h-[80vh] rounded-lg"
            onError={(e) => {
              const el = e.currentTarget
              // 失败后隐藏播放器，改由下方文案说明（避免留下一个卡住的空播放器）
              el.style.display = 'none'
              const tip = el.nextElementSibling as HTMLElement | null
              if (tip) tip.style.display = 'block'
            }}
          />
        )}
        {/* 视频失败提示（默认隐藏，onError 时显示） */}
        <div
          style={{ display: 'none' }}
          className="flex flex-col items-center gap-2 py-16 text-center"
        >
          <span className="text-sm text-text-secondary">视频加载失败，链接可能已过期</span>
          <span className="text-xs text-text-muted">请重新生成，或到「我的视频」查看已保存的记录</span>
        </div>
        <div className="p-3">
          <MediaActionsBar url={video} kind="video" name="视频" onClose={onCloseVideo} align="center" />
        </div>
      </Modal>
    </>
  )
}
