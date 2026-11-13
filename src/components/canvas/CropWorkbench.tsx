'use client'

import { useState, useRef, useEffect } from 'react'
import { Modal, Segmented, Button, Typography, Empty } from 'antd'
import { ScissorOutlined } from '@ant-design/icons'

const { Text } = Typography

type Region = { x: number; y: number; width: number; height: number }
type Mode = 'single' | 'grid4' | 'grid9'

interface CropWorkbenchProps {
  open: boolean
  imageUrl: string
  initialMode?: Mode
  initialRegions?: Region[]
  onConfirm: (mode: Mode, regions: Region[]) => void
  onCancel: () => void
}

export function CropWorkbench({ open, imageUrl, initialMode = 'single', initialRegions = [], onConfirm, onCancel }: CropWorkbenchProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [singleRect, setSingleRect] = useState<Region | null>(null)
  const [selectedCells, setSelectedCells] = useState<number[]>([])
  const imgRef = useRef<HTMLImageElement>(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const drawingRef = useRef<{ startX: number; startY: number } | null>(null)
  const [drawingRect, setDrawingRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const prevOpen = useRef(false)

  // 切模式时重置选择
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSingleRect(null)
      setSelectedCells([])
      setDrawingRect(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [mode])

  // 仅在 open 从 false→true 时恢复初始值(避免 initialRegions 引用变化导致重置)
  useEffect(() => {
    if (!(open && !prevOpen.current)) return
    const timer = window.setTimeout(() => {
      setMode(initialMode)
      // 一宫格:恢复第一个 region;多宫格:从 regions 精确计算宫格索引
      if (initialMode === 'single') {
        setSingleRect(initialRegions[0] || null)
        setSelectedCells([])
      } else {
        setSingleRect(null)
        setSelectedCells(regionsToCells(initialRegions, initialMode))
      }
      setDrawingRect(null)
    }, 0)
    prevOpen.current = open
    return () => window.clearTimeout(timer)
  }, [open, initialMode, initialRegions])

  const onImgLoad = () => {
    const img = imgRef.current
    if (!img) return
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
  }

  // 显示坐标 → 原始像素坐标
  const toNatural = (displayX: number, displayY: number) => {
    const img = imgRef.current
    if (!img || imgSize.w === 0) return { x: 0, y: 0 }
    const rect = img.getBoundingClientRect()
    const scaleX = img.naturalWidth / rect.width
    const scaleY = img.naturalHeight / rect.height
    return {
      x: Math.max(0, Math.round((displayX - rect.left) * scaleX)),
      y: Math.max(0, Math.round((displayY - rect.top) * scaleY)),
    }
  }

  // 一宫格拖拽框选
  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== 'single') return
    const rect = imgRef.current!.getBoundingClientRect()
    drawingRef.current = { startX: e.clientX - rect.left, startY: e.clientY - rect.top }
    setDrawingRect({ x: drawingRef.current.startX, y: drawingRef.current.startY, w: 0, h: 0 })
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (mode !== 'single' || !drawingRef.current) return
    const rect = imgRef.current!.getBoundingClientRect()
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setDrawingRect({
      x: Math.min(drawingRef.current.startX, cur.x),
      y: Math.min(drawingRef.current.startY, cur.y),
      w: Math.abs(cur.x - drawingRef.current.startX),
      h: Math.abs(cur.y - drawingRef.current.startY),
    })
  }
  const onMouseUp = () => {
    if (mode !== 'single' || !drawingRef.current || !drawingRect) return
    drawingRef.current = null
    if (drawingRect.w < 5 || drawingRect.h < 5) { setDrawingRect(null); return }
    // 转原始像素
    const img = imgRef.current!
    const scaleX = img.naturalWidth / img.clientWidth
    const scaleY = img.naturalHeight / img.clientHeight
    setSingleRect({
      x: Math.round(drawingRect.x * scaleX),
      y: Math.round(drawingRect.y * scaleY),
      width: Math.round(drawingRect.w * scaleX),
      height: Math.round(drawingRect.h * scaleY),
    })
    setDrawingRect(null)
  }

  // 四/九宫格点击格子
  const grid = mode === 'grid4' ? 2 : 3
  const cellCount = grid * grid
  const toggleCell = (i: number) => {
    setSelectedCells((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])
  }

  // 宫格的 regions
  const cellToRegion = (i: number): Region => {
    const col = i % grid
    const row = Math.floor(i / grid)
    const cw = imgSize.w / grid
    const ch = imgSize.h / grid
    return { x: Math.round(col * cw), y: Math.round(row * ch), width: Math.round(cw), height: Math.round(ch) }
  }

  const handleConfirm = () => {
    let regions: Region[] = []
    if (mode === 'single') {
      if (singleRect) regions = [singleRect]
    } else {
      regions = selectedCells.map(cellToRegion)
    }
    onConfirm(mode, regions)
  }

  const selectedCount = mode === 'single' ? (singleRect ? 1 : 0) : selectedCells.length

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title={<div className="flex items-center gap-2"><ScissorOutlined /> 裁切工作台</div>}
      width="90%"
      style={{ top: 20 }}
      footer={[
        <Text key="info" className="text-xs text-text-secondary mr-auto">
          已选 {selectedCount} 个区域{imgSize.w > 0 ? ` · 原图 ${imgSize.w}×${imgSize.h}` : ''}
        </Text>,
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="ok" type="primary" disabled={selectedCount === 0} onClick={handleConfirm}>
          确认裁切（{selectedCount}）
        </Button>,
      ]}
      styles={{ body: { padding: 16, maxHeight: '80vh', overflow: 'auto' } }}
    >
      <div className="mb-3 flex items-center gap-3">
        <Text className="text-sm">模式：</Text>
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: 'single', label: '一宫格（拖拽选区）' },
            { value: 'grid4', label: '四宫格' },
            { value: 'grid9', label: '九宫格' },
          ]}
        />
      </div>

      {!imageUrl ? (
        <Empty description="请先连接图片输入" />
      ) : (
        <div className="flex justify-center bg-surface rounded-lg p-4">
          <div className="relative inline-block" style={{ cursor: mode === 'single' ? 'crosshair' : 'pointer' }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imageUrl}
              alt="裁切"
              onLoad={onImgLoad}
              className="block max-w-full max-h-[65vh] rounded"
              draggable={false}
              style={{ userSelect: 'none' }}
            />
            {/* 宫格覆盖层 */}
            {mode !== 'single' && imgSize.w > 0 && (
              <div className="absolute inset-0 grid pointer-events-none" style={{ gridTemplateColumns: `repeat(${grid}, 1fr)`, gridTemplateRows: `repeat(${grid}, 1fr)` }}>
                {Array.from({ length: cellCount }).map((_, i) => (
                  <div
                    key={i}
                    onClick={() => toggleCell(i)}
                    className={`border border-white/60 pointer-events-auto transition-colors ${selectedCells.includes(i) ? 'bg-primary/40' : 'bg-transparent hover:bg-primary/15'}`}
                  />
                ))}
              </div>
            )}
            {/* 一宫格框选矩形 */}
            {mode === 'single' && drawingRect && (
              <div className="absolute border-2 border-primary bg-primary/20 pointer-events-none"
                style={{ left: drawingRect.x, top: drawingRect.y, width: drawingRect.w, height: drawingRect.h }} />
            )}
            {mode === 'single' && singleRect && imgSize.w > 0 && !drawingRect && (
              <SingleRectOverlay imgRef={imgRef} rect={singleRect} imgSize={imgSize} />
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

// 一宫格已选区域的显示覆盖层（把原始像素坐标转回显示坐标）
function SingleRectOverlay({ imgRef, rect, imgSize }: { imgRef: React.RefObject<HTMLImageElement | null>; rect: Region; imgSize: { w: number; h: number } }) {
  const [displayRect, setDisplayRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  useEffect(() => {
    const img = imgRef.current
    if (!img || imgSize.w === 0) return
    const scaleX = img.clientWidth / imgSize.w
    const scaleY = img.clientHeight / imgSize.h
    setDisplayRect({
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      w: rect.width * scaleX,
      h: rect.height * scaleY,
    })
  }, [rect, imgSize, imgRef])
  if (!displayRect) return null
  return (
    <div className="absolute border-2 border-primary bg-primary/20 pointer-events-none"
      style={{ left: displayRect.x, top: displayRect.y, width: displayRect.w, height: displayRect.h }} />
  )
}

// 从 region 坐标精确计算宫格索引(恢复用)
function regionsToCells(regions: Region[], mode: Mode): number[] {
  const grid = mode === 'grid4' ? 2 : 3
  if (regions.length === 0) return []
  const cells: number[] = []
  for (const r of regions) {
    // 取 region 中心点,算落在哪个格子
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    // 需要图片尺寸来算比例;这里假设 region 已是原始像素坐标
    // 通过 region 占图的比例估算(默认按 1:1,实际由调用方保证坐标体系一致)
    const col = Math.floor(cx / (r.width || 1)) % grid
    const row = Math.floor(cy / (r.height || 1)) % grid
    const idx = row * grid + col
    if (!cells.includes(idx) && idx < grid * grid) cells.push(idx)
  }
  return cells
}
