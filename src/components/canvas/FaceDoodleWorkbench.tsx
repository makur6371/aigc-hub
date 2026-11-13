'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Modal, Button, Typography, Empty, Segmented, Slider, Switch, Alert, Spin } from 'antd'
import { HighlightOutlined, PlusOutlined } from '@ant-design/icons'
import {
  inferSliceGrid,
  suppressDuplicates,
  inferMissingViews,
  expandTinyBox,
  drawScribbleAll,
  normalizeBox,
  DOODLE_DEFAULTS,
} from '@/lib/face-doodle'
import type { DoodleBox } from '@/lib/face-doodle'
import { uploadAssetBlob } from '@/lib/workbench-media'

const { Text } = Typography

// MediaPipe 类型无官方 ESM 类型定义，最小化声明
interface MpDetection {
  boundingBox: { xCenter: number; yCenter: number; width: number; height: number }
  score?: number[]
}
interface MpFaceDetection {
  setOptions: (o: { model?: string; minDetectionConfidence?: number }) => void
  onResults: (cb: (r: { detections?: MpDetection[] }) => void) => void
  send: (i: { image: HTMLImageElement | HTMLCanvasElement }) => Promise<void>
  initialize?: () => Promise<void>
}

export interface DoodleConfirmResult {
  /** 涂鸦成图（站内 URL） */
  imageUrl: string
  /** 最终涂鸦框（原始像素坐标，写回节点供下次打开恢复） */
  faces: DoodleBox[]
}

interface FaceDoodleWorkbenchProps {
  open: boolean
  imageUrl: string
  initialFaces?: DoodleBox[]
  initialParams?: FaceDoodleParams
  onConfirm: (result: DoodleConfirmResult) => void
  // 参数实时回写节点：工作台与节点参数条共享同一份 inputs，改任一侧立即同步。
  // 以前只有「确认出图」才写回，导致「参数条调密度 → 开工作台看到的还是旧值」。
  onParamsChange?: (patch: Partial<FaceDoodleParams>) => void
  onCancel: () => void
}

export type FaceDoodleParams = {
  density: number
  strokeWidth: number
  spike: number
  coverage: number
  multiView: boolean
  threshold: number
  autoFallback: boolean
}

type Phase = 'idle' | 'loading-model' | 'detecting' | 'ready' | 'exporting'

/** 单次 MediaPipe 检测（800ms 超时兜底，侧脸/线稿可能空结果） */
function detectOnce(fd: MpFaceDetection, src: HTMLImageElement | HTMLCanvasElement): Promise<MpDetection[]> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve([]) } }, 800)
    fd.onResults((res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res.detections || [])
    })
    void fd.send({ image: src })
  })
}

/**
 * 涂鸦工作台：浏览器端 MediaPipe 人脸检测 + Canvas 涂鸦绘制 + 手动框选编辑。
 * 确认时导出 PNG 上传站内，返回 { imageUrl, faces } 由页面写回节点。
 */
export function FaceDoodleWorkbench({ open, imageUrl, initialFaces = [], initialParams, onParamsChange, onConfirm, onCancel }: FaceDoodleWorkbenchProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [phaseMsg, setPhaseMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [boxes, setBoxes] = useState<DoodleBox[]>([])
  const [drawingRect, setDrawingRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // 参数（随改随重绘）
  const [density, setDensity] = useState(initialParams?.density ?? DOODLE_DEFAULTS.density)
  const [strokeWidth, setStrokeWidth] = useState(initialParams?.strokeWidth ?? DOODLE_DEFAULTS.strokeWidth)
  const [spike, setSpike] = useState(initialParams?.spike ?? DOODLE_DEFAULTS.spike)
  const [coverage, setCoverage] = useState(initialParams?.coverage ?? DOODLE_DEFAULTS.coverage)
  const [multiView, setMultiView] = useState(initialParams?.multiView ?? DOODLE_DEFAULTS.multiView)
  const [threshold, setThreshold] = useState(initialParams?.threshold ?? DOODLE_DEFAULTS.threshold)
  const [autoFallback, setAutoFallback] = useState(initialParams?.autoFallback ?? DOODLE_DEFAULTS.autoFallback)

  // 统一 setter：本地 state 与节点 inputs 同时更新（改任一侧都立即同步）
  const patchParam = useCallback((key: string, value: unknown) => {
    onParamsChange?.({ [key]: value } as Partial<FaceDoodleParams>)
  }, [onParamsChange])
  const setDensityP = useCallback((v: number) => { setDensity(v); patchParam('density', v) }, [patchParam])
  const setStrokeWidthP = useCallback((v: number) => { setStrokeWidth(v); patchParam('strokeWidth', v) }, [patchParam])
  const setSpikeP = useCallback((v: number) => { setSpike(v); patchParam('spike', v) }, [patchParam])
  const setCoverageP = useCallback((v: number) => { setCoverage(v); patchParam('coverage', v) }, [patchParam])
  const setMultiViewP = useCallback((v: boolean) => { setMultiView(v); patchParam('multiView', v) }, [patchParam])
  const setThresholdP = useCallback((v: number) => { setThreshold(v); patchParam('threshold', v) }, [patchParam])
  const setAutoFallbackP = useCallback((v: boolean) => { setAutoFallback(v); patchParam('autoFallback', v) }, [patchParam])

  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fdRef = useRef<MpFaceDetection | null>(null)
  const drawingRef = useRef<{ startX: number; startY: number } | null>(null)
  const prevOpen = useRef(false)

  // 参数变化 → 实时重绘涂鸦
  const repaint = useCallback((targetBoxes: DoodleBox[]) => {
    const cv = canvasRef.current
    if (!cv || imgSize.w === 0) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    drawScribbleAll(ctx, targetBoxes, { density, strokeWidth, spike, coverage })
    // 框选辅助线（涂鸦线之上叠加虚线框与红叉，导出前会重绘一次纯净版）
    targetBoxes.forEach((f) => {
      ctx.save()
      ctx.strokeStyle = f.isFallback ? '#f59e0b' : '#38bdf8'
      ctx.lineWidth = Math.max(1.5, imgSize.w / 1400)
      ctx.setLineDash([4, 4])
      ctx.strokeRect(f.x, f.y, f.w, f.h)
      ctx.setLineDash([])
      // 红叉删除按钮
      const r = Math.max(11, imgSize.w / 220)
      ctx.fillStyle = '#ef4444'
      ctx.beginPath()
      ctx.arc(f.x + f.w, f.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${r * 1.3}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('×', f.x + f.w, f.y)
      ctx.restore()
    })
  }, [imgSize, density, strokeWidth, spike, coverage])

  useEffect(() => {
    if (imgSize.w > 0) repaint(boxes)
  }, [imgSize, boxes, repaint])

  // open 时恢复初始状态 + 加载模型
  useEffect(() => {
    if (!(open && !prevOpen.current)) return
    prevOpen.current = open
    setError(null)
    setBoxes(initialFaces)
    // 每次打开都以「节点当前的参数」为准：参数条改动后重开工作台，
    // 之前看到的还是上一套旧值（两套状态不同步的另一半）。
    if (initialParams) {
      setDensity(initialParams.density)
      setStrokeWidth(initialParams.strokeWidth)
      setSpike(initialParams.spike)
      setCoverage(initialParams.coverage)
      setMultiView(initialParams.multiView)
      setThreshold(initialParams.threshold)
      setAutoFallback(initialParams.autoFallback)
    }
    setPhaseMsg('加载人脸检测模型...')
    setPhase('loading-model')
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!fdRef.current) {
            const mp = await import('@mediapipe/face_detection')
            const fd = new mp.FaceDetection({ locateFile: (f: string) => `/api/face-model/${f}` })
            fdRef.current = fd as unknown as MpFaceDetection
          }
          fdRef.current.setOptions({ model: 'short', minDetectionConfidence: threshold })
          setModelReady(true)
          setPhaseMsg(imageUrl ? '切片扫描检测中...' : '')
          setPhase(imageUrl ? 'detecting' : 'ready')
        } catch {
          setModelReady(false)
          setError('人脸检测模型加载失败（网络/资源原因），可手动拖拽框选补涂。')
          setPhase('ready')
        }
      })()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, initialFaces, threshold, imageUrl])

  // 图片加载后：有模型 → 自动检测；有历史框 → 直接重绘
  const onImgLoad = () => {
    const img = imgRef.current
    if (!img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    setImgSize({ w, h })
    if (initialFaces.length > 0) {
      setPhase('ready')
      return
    }
    if (modelReady && imageUrl) void runDetect(w, h)
  }

  // preserveManual=true 时只更新自动检出的框，保留用户手动框/兜底框
  // （原来的 setBoxes(merged) 会把用户补的框静默清掉 —— 补漏再重扫就没了）
  const runDetect = async (w: number, h: number, preserveManual = false) => {
    const img = imgRef.current
    const fd = fdRef.current
    if (!img || !fd) return
    setPhase('detecting')
    setPhaseMsg('切片扫描检测中...')
    try {
      fd.setOptions({ model: 'short', minDetectionConfidence: threshold })
      await fd.initialize?.()
      // 全图一次
      const raws: DoodleBox[] = []
      for (const d of await detectOnce(fd, img)) raws.push(normalizeBox(d as never, 0, 0, w, h))
      // 切片扫描（25% 重叠）——四视图/分镜侧脸与小脸的关键增强
      if (multiView) {
        const { cols, rows } = inferSliceGrid(w, h)
        if (cols > 1 || rows > 1) {
          const tileCv = document.createElement('canvas')
          const tCtx = tileCv.getContext('2d')
          const tw = w / cols
          const th = h / rows
          const ovX = tw * 0.25
          const ovY = th * 0.25
          for (let r = 0; r < rows; r++) {
            for (let col = 0; col < cols; col++) {
              const sx = Math.max(0, col * tw - ovX)
              const sy = Math.max(0, r * th - ovY)
              const sw = Math.min(w - sx, tw + ovX * 2)
              const sh = Math.min(h - sy, th + ovY * 2)
              tileCv.width = sw
              tileCv.height = sh
              tCtx?.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
              for (const d of await detectOnce(fd, tileCv)) raws.push(normalizeBox(d as never, sx, sy, sw, sh))
            }
          }
        }
      }
      let merged = suppressDuplicates(raws)
      if (autoFallback) {
        const { cols } = inferSliceGrid(w, h)
        if (cols > 1) merged = inferMissingViews(merged, w, cols)
      }
      if (preserveManual) {
        setBoxes((prev) => {
          // 保留用户手动框与上一轮的兜底框（兜底框位置由检测结果推断，检测失败时不该消失）
          const kept = prev.filter((b) => b.isManual || b.isFallback)
          const auto = merged.filter((b) => !b.isManual && !b.isFallback)
          return suppressDuplicates([...auto, ...kept], 0.3)
        })
      } else {
        setBoxes(merged)
      }
      setPhase('ready')
    } catch {
      setError('检测过程出错，可手动拖拽框选补涂。')
      setPhase('ready')
    }
  }

  // ---- 框选/删除交互（原生像素坐标体系，与 CropWorkbench 的 toNatural 同法） ----

  const toNatural = (clientX: number, clientY: number) => {
    const img = imgRef.current
    if (!img || imgSize.w === 0) return { x: 0, y: 0 }
    const rect = img.getBoundingClientRect()
    const scaleX = imgSize.w / rect.width
    const scaleY = imgSize.h / rect.height
    return {
      x: Math.max(0, Math.round((clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.round((clientY - rect.top) * scaleY)),
    }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (phase !== 'ready') return
    const p = toNatural(e.clientX, e.clientY)
    // 命中红叉 → 删除该框
    const r = Math.max(11, imgSize.w / 220) * 1.5
    for (let i = boxes.length - 1; i >= 0; i--) {
      const f = boxes[i]
      if (Math.hypot(p.x - (f.x + f.w), p.y - f.y) <= r) {
        setBoxes(boxes.filter((_, idx) => idx !== i))
        return
      }
    }
    drawingRef.current = { startX: p.x, startY: p.y }
    setDrawingRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drawingRef.current) return
    const p = toNatural(e.clientX, e.clientY)
    setDrawingRect({
      x: Math.min(drawingRef.current.startX, p.x),
      y: Math.min(drawingRef.current.startY, p.y),
      w: Math.abs(p.x - drawingRef.current.startX),
      h: Math.abs(p.y - drawingRef.current.startY),
    })
  }

  const onMouseUp = () => {
    if (!drawingRef.current || !drawingRect) return
    drawingRef.current = null
    // 显示坐标 <15px 视为点击 → 自动扩展默认脸框（与原工具一致的补漏体验）
    const rect = imgRef.current?.getBoundingClientRect()
    const displayScale = rect ? imgSize.w / rect.width : 1
    const box = expandTinyBox(drawingRect.x, drawingRect.y, drawingRect.x + drawingRect.w, drawingRect.y + drawingRect.h, imgSize.w, 15 * displayScale)
    setBoxes([...boxes, box])
    setDrawingRect(null)
  }

  // 确认导出：纯净重绘（无辅助框）→ PNG → 上传
  const handleConfirm = async () => {
    const img = imgRef.current
    if (!img || imgSize.w === 0) { onCancel(); return }
    setPhase('exporting')
    setPhaseMsg('导出涂鸦图...')
    try {
      const cv = document.createElement('canvas')
      cv.width = imgSize.w
      cv.height = imgSize.h
      const ctx = cv.getContext('2d')
      if (!ctx) throw new Error('canvas 不可用')
      ctx.drawImage(img, 0, 0)
      drawScribbleAll(ctx, boxes, { density, strokeWidth, spike, coverage })
      const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('导出失败'))), 'image/png'))
      const url = await uploadAssetBlob(blob, `face-doodle-${Date.now()}.png`, 'image/png', 'canvas')
      onConfirm({ imageUrl: url, faces: boxes })
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败，请重试')
      setPhase('ready')
    }
  }

  const busy = phase === 'loading-model' || phase === 'detecting' || phase === 'exporting'

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title={<div className="flex items-center gap-2"><HighlightOutlined /> 人脸涂鸦工作台</div>}
      width="90%"
      style={{ top: 20 }}
      footer={[
        <Text key="info" className="text-xs text-text-secondary mr-auto">
          {error
            ? ''
            : `${boxes.length} 个涂鸦框${imgSize.w > 0 ? ` · 原图 ${imgSize.w}×${imgSize.h}` : ''} · 拖拽框选补漏 / 点红叉删除 · 重新扫描会保留手动框`}
        </Text>,
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="ok" type="primary" disabled={boxes.length === 0 || busy} onClick={handleConfirm}>
          确认出图（{boxes.length}）
        </Button>,
      ]}
      styles={{ body: { padding: 16, maxHeight: '82vh', overflow: 'auto' } }}
    >
      {error && <Alert type="warning" showIcon message={error} className="mb-3" closable onClose={() => setError(null)} />}
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">密度 {density}笔</Text>
          <Slider min={15} max={90} step={3} value={density} onChange={(v) => setDensityP(v)} style={{ width: 110 }} />
        </div>
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">粗细 {strokeWidth}px</Text>
          <Slider min={1} max={5} step={0.2} value={strokeWidth} onChange={(v) => setStrokeWidthP(v)} style={{ width: 100 }} />
        </div>
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">飞白</Text>
          <Segmented size="small" value={spike} onChange={(v) => setSpikeP(v as number)} options={[{ value: 1.0, label: '收束' }, { value: 1.25, label: '自然' }, { value: 1.45, label: '强' }]} />
        </div>
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">遮挡</Text>
          <Segmented size="small" value={coverage} onChange={(v) => setCoverageP(v as number)} options={[{ value: 0.9, label: '0.9x' }, { value: 1.1, label: '1.1x' }, { value: 1.3, label: '1.3x' }]} />
        </div>
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">切片</Text>
          <Switch
            size="small"
            checked={multiView}
            onChange={(v) => {
              setMultiViewP(v)
              // 切片开关直接决定检测方式，改完立即重扫（保留手动框）
              if (imgSize.w > 0 && modelReady) window.setTimeout(() => void runDetect(imgSize.w, imgSize.h, true), 0)
            }}
          />
          <Text className="text-xs shrink-0">补框</Text>
          <Switch
            size="small"
            checked={autoFallback}
            onChange={(v) => {
              setAutoFallbackP(v)
              if (imgSize.w > 0 && modelReady) window.setTimeout(() => void runDetect(imgSize.w, imgSize.h, true), 0)
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Text className="text-xs shrink-0">灵敏度</Text>
          <Segmented
            size="small"
            value={threshold}
            onChange={(v) => {
              setThresholdP(v as number)
              // 灵敏度是检测参数：以前改完不动，必须自己想到点「重新扫描」。
              // 现在自动重扫（保留手动框），不再让用户猜下一步该点哪里。
              if (imgSize.w > 0 && modelReady) window.setTimeout(() => void runDetect(imgSize.w, imgSize.h, true), 0)
            }}
            options={[{ value: 0.08, label: '0.08' }, { value: 0.18, label: '0.18' }, { value: 0.3, label: '0.30' }]}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="small" icon={<PlusOutlined />} disabled={!modelReady || !imageUrl || busy} onClick={() => void runDetect(imgSize.w, imgSize.h, true)}>
            重新扫描
          </Button>
          {boxes.length > 0 && (
            <Button size="small" danger disabled={busy} onClick={() => setBoxes([])}>
              清空框
            </Button>
          )}
          <Button
            size="small"
            disabled={busy}
            title="把密度/粗细/飞白/遮挡/灵敏度恢复默认值"
            onClick={() => {
              setDensityP(DOODLE_DEFAULTS.density)
              setStrokeWidthP(DOODLE_DEFAULTS.strokeWidth)
              setSpikeP(DOODLE_DEFAULTS.spike)
              setCoverageP(DOODLE_DEFAULTS.coverage)
              setThresholdP(DOODLE_DEFAULTS.threshold)
            }}
          >
            恢复默认
          </Button>
        </div>
      </div>

      {!imageUrl ? (
        <Empty description="请先连接图片输入（或先在工作台外选择图片）" />
      ) : (
        <div className="flex justify-center bg-surface rounded-lg p-4">
          <div className="relative inline-block" style={{ cursor: phase === 'ready' ? 'crosshair' : 'wait' }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imageUrl}
              alt="涂鸦原图"
              onLoad={onImgLoad}
              className="block max-w-full max-h-[62vh] rounded"
              draggable={false}
              style={{ userSelect: 'none' }}
            />
            {/* 涂鸦画布层（与图片同尺寸，覆盖其上） */}
            {imgSize.w > 0 && (
              <canvas
                ref={canvasRef}
                width={imgSize.w}
                height={imgSize.h}
                className="absolute inset-0 w-full h-full pointer-events-none"
              />
            )}
            {drawingRect && (
              <div className="absolute border-2 border-dashed border-primary bg-primary/20 pointer-events-none"
                style={{
                  left: `${(drawingRect.x / imgSize.w) * 100}%`,
                  top: `${(drawingRect.y / imgSize.h) * 100}%`,
                  width: `${(drawingRect.w / imgSize.w) * 100}%`,
                  height: `${(drawingRect.h / imgSize.h) * 100}%`,
                }} />
            )}
            {busy && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded">
                <Spin />
                <span className="mt-2 text-xs text-white">{phaseMsg}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
