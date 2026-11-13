'use client'

/**
 * 发布封面排版编辑器：多图套图时让用户手动框选每张图的大小/位置 + 调整外框比例。
 * - 外框按 ratio 显示，格子坐标为归一化 0~1（存储与渲染解耦，作品广场按百分比还原）
 * - 每格可拖动移动、右下角把手缩放；Pointer Events 实现（兼容触屏）
 * - 布局结果 { ratio, cells } 随 /api/works 提交存 SharedWork.coverLayout
 */
import { useRef, useState, useCallback } from 'react'
import { Button, Segmented, App } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

export type CoverCell = { url: string; x: number; y: number; w: number; h: number }
export type CoverLayout = { ratio: string; cells: CoverCell[] }

const RATIOS = [
  { label: '4:3', value: '4/3' },
  { label: '1:1', value: '1/1' },
  { label: '16:9', value: '16/9' },
  { label: '3:4', value: '3/4' },
]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// 默认布局：封面大图占左上 2/3 宽 + 其余小图右侧/底部（与作品广场默认套图一致的观感）
export function defaultLayout(images: string[], coverUrl?: string): CoverLayout {
  const cover = coverUrl && images.includes(coverUrl) ? coverUrl : images[0]
  const rest = images.filter((u) => u !== cover).slice(0, 4)
  const cells: CoverCell[] = [{ url: cover, x: 0, y: 0, w: rest.length ? 2 / 3 : 1, h: rest.length ? 2 / 3 : 1 }]
  if (rest.length > 0) {
    // 右侧一列（最多 2 个）+ 底部一行（最多 2 个）
    const right = rest.slice(0, 2)
    const bottom = rest.slice(2, 4)
    right.forEach((u, i) => cells.push({ url: u, x: 2 / 3, y: (i * (2 / 3)) / right.length, w: 1 / 3, h: (2 / 3) / right.length }))
    if (bottom.length > 0) {
      cells.push({ url: bottom[0], x: 0, y: 2 / 3, w: bottom.length > 1 ? 2 / 3 : 1, h: 1 / 3 })
      if (bottom.length > 1) cells.push({ url: bottom[1], x: 2 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 })
    }
  }
  return { ratio: '4/3', cells }
}

export function CoverLayoutEditor({
  images,
  coverUrl,
  value,
  onChange,
}: {
  images: string[]
  coverUrl?: string
  value: CoverLayout
  onChange: (v: CoverLayout) => void
}) {
  const { message } = App.useApp()
  const boxRef = useRef<HTMLDivElement>(null)
  // 拖拽/缩放中的临时态（渲染优先用，结束才 commit 到 value）
  const [active, setActive] = useState<{ idx: number; mode: 'move' | 'resize' } | null>(null)

  const cellAt = (clientX: number, clientY: number) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null
    return {
      x: (clientX - box.left) / box.width,
      y: (clientY - box.top) / box.height,
    }
  }

  const startDrag = (e: React.PointerEvent, idx: number, mode: 'move' | 'resize') => {
    e.stopPropagation()
    e.preventDefault()
    const start = cellAt(e.clientX, e.clientY)
    if (!start) return
    const startCell = { ...value.cells[idx] }
    setActive({ idx, mode })

    const onMove = (ev: PointerEvent) => {
      const cur = cellAt(ev.clientX, ev.clientY)
      if (!cur) return
      const cells = value.cells.map((c, i) => {
        if (i !== idx) return c
        if (mode === 'move') {
          // 拖动：保持抓取点相对偏移
          return { ...c, x: clamp01(startCell.x + (cur.x - start.x)), y: clamp01(startCell.y + (cur.y - start.y)) }
        }
        // resize：右下角把手
        return {
          ...c,
          w: Math.max(0.1, Math.min(1 - c.x, startCell.w + (cur.x - start.x))),
          h: Math.max(0.1, Math.min(1 - c.y, startCell.h + (cur.y - start.y))),
        }
      })
      onChange({ ...value, cells })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setActive(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const setRatio = (r: string) => onChange({ ...value, ratio: r })
  const reset = useCallback(() => {
    onChange(defaultLayout(images, coverUrl))
    message.info('已恢复默认排版')
  }, [images, coverUrl, onChange, message])

  const [wStr, hStr] = value.ratio.split('/')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">封面排版（拖动图片调整位置，右下角把手调整大小）</span>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reset} title="恢复默认排版" />
      </div>
      <div
        ref={boxRef}
        className="relative w-full overflow-hidden rounded-lg border border-border bg-surface touch-none select-none"
        style={{ aspectRatio: `${wStr} / ${hStr}` }}
      >
        {value.cells.map((c, i) => (
          <div
            key={i}
            className={`absolute overflow-hidden ${active?.idx === i ? 'ring-2 ring-accent z-10' : 'ring-1 ring-black/10'}`}
            style={{
              left: `${(c.x * 100).toFixed(2)}%`,
              top: `${(c.y * 100).toFixed(2)}%`,
              width: `${(c.w * 100).toFixed(2)}%`,
              height: `${(c.h * 100).toFixed(2)}%`,
              cursor: active?.idx === i && active.mode === 'move' ? 'grabbing' : 'grab',
            }}
            onPointerDown={(e) => startDrag(e, i, 'move')}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.url} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />
            {/* 缩放把手 */}
            <span
              className="absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize bg-accent/85"
              style={{ borderRadius: '4px 0 4px 0' }}
              onPointerDown={(e) => startDrag(e, i, 'resize')}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary shrink-0">外框比例</span>
        <Segmented size="small" options={RATIOS} value={value.ratio} onChange={(v) => setRatio(v as string)} />
        <span className="text-[11px] text-text-disabled ml-auto">格子可重叠；留空区域显示底色</span>
      </div>
    </div>
  )
}
