'use client'

// 图片编辑器：工业化工具栏（裁剪/旋转/镜像/涂鸦/马赛克/文字/贴图/画中画/水印/边框/AI 消水印）。
// 操作模型：破坏性编辑——每次「应用」把操作固化到 base canvas，可连续多个工具，最后「保存」上传素材库。
// 零依赖纯 canvas；AI 消水印走 /api/image/cleanup（框选标注图 + 图生图）。
import { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Tooltip, Input, Slider, InputNumber, Empty } from 'antd'
import {
  ScissorOutlined, RotateRightOutlined, SwapOutlined, EditOutlined, BlockOutlined,
  FontSizeOutlined, PicRightOutlined, BorderOuterOutlined, ThunderboltOutlined, HighlightOutlined,
  CheckOutlined, CloseOutlined, DownloadOutlined, UndoOutlined, LoadingOutlined, PictureOutlined,
} from '@ant-design/icons'
import { uploadAssetBlob } from '@/lib/workbench-media'
import { toProxyUrl } from '@/lib/media-url'
import { ORG } from '@/lib/site-content'
import { AnimatedLogo } from '@/components/ui/AnimatedLogo'

type ToolId = 'crop' | 'rotate' | 'flip' | 'draw' | 'mosaic' | 'text' | 'sticker' | 'pip' | 'border' | 'watermark' | 'cleanup'

const TOOLS: Array<{ id: ToolId; label: string; icon: React.ReactNode }> = [
  { id: 'crop', label: '裁剪', icon: <ScissorOutlined /> },
  { id: 'rotate', label: '旋转', icon: <RotateRightOutlined /> },
  { id: 'flip', label: '镜像', icon: <SwapOutlined /> },
  { id: 'draw', label: '涂鸦', icon: <EditOutlined /> },
  { id: 'mosaic', label: '马赛克', icon: <BlockOutlined /> },
  { id: 'text', label: '文字', icon: <FontSizeOutlined /> },
  { id: 'sticker', label: '贴图', icon: <PictureOutlined /> },
  { id: 'pip', label: '画中画', icon: <PicRightOutlined /> },
  { id: 'watermark', label: '水印', icon: <HighlightOutlined /> },
  { id: 'border', label: '边框', icon: <BorderOuterOutlined /> },
  { id: 'cleanup', label: 'AI 消水印', icon: <ThunderboltOutlined /> },
]

interface ImageEditorProps {
  url: string
  label?: string
  onProduced: (item: { url: string; kind: 'image'; label: string; fromUrl?: string }) => void
  message: { success: (t: string) => void; error: (t: string) => void; warning: (t: string) => void; info: (t: string) => void }
}

export function ImageEditor({ url, label, onProduced, message }: ImageEditorProps) {
  const [tool, setTool] = useState<ToolId | null>(null)
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [disp, setDisp] = useState({ w: 0, h: 0 }) // 画布显示尺寸（自适应容器，不放大超原始）
  const [dirty, setDirty] = useState(false) // base 有未保存修改
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const baseRef = useRef<HTMLCanvasElement>(null) // 当前图像状态
  const imgRef = useRef<HTMLImageElement>(null) // 显示尺寸参照
  const stageRef = useRef<HTMLDivElement>(null) // 工作区容器（测可用宽高）
  const historyRef = useRef<ImageData[]>([]) // 撤销栈
  const [historyCount, setHistoryCount] = useState(0)

  // ===== 显示尺寸自适应：容器变化 / 图像变化时重算 =====
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || nat.w === 0) return
    const fit = () => {
      const pad = 32
      const maxW = Math.max(120, stage.clientWidth - pad)
      const maxH = Math.max(120, stage.clientHeight - pad)
      const scale = Math.min(1, maxW / nat.w, maxH / nat.h)
      setDisp({ w: Math.round(nat.w * scale), h: Math.round(nat.h * scale) })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [nat])

  // ===== 加载原图：fetch blob（站内素材接口需 cookie；blob 加载也避免 canvas 跨域污染） =====
  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    void (async () => {
      try {
        let src = url
        let res = await fetch(src, { credentials: 'include' })
        // 站外链接（如历史遗留的厂商临时外链）浏览器 fetch 可能被拦/防盗链：走本站代理兜底
        if (!res.ok && /^https?:\/\//.test(url)) {
          // 代理地址统一走 toProxyUrl()：它同时处理「已是代理不二次嵌套」与「站内地址不套代理」，
          // 手搓模板串会漏掉这两种情况（双重代理 / 给 /api/ 地址套代理）。
          const proxied = await fetch(toProxyUrl(url), { credentials: 'include' })
          if (proxied.ok) { res = proxied; src = proxied.url }
        }
        if (!res.ok) throw new Error('图片加载失败')
        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          if (!alive) return
          setNat({ w: img.naturalWidth, h: img.naturalHeight })
          const cv = baseRef.current
          if (!cv) return
          cv.width = img.naturalWidth
          cv.height = img.naturalHeight
          cv.getContext('2d')?.drawImage(img, 0, 0)
          historyRef.current = []
          setHistoryCount(0)
          setDirty(false)
          setLoading(false)
        }
        img.src = objectUrl
      } catch (e) {
        if (alive) {
          setLoading(false)
          setLoadError(true)
          message.error(e instanceof Error ? e.message : '图片加载失败')
        }
      }
    })()
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, message])

  const pushHistory = useCallback(() => {
    const cv = baseRef.current
    if (!cv) return
    const g = cv.getContext('2d')
    if (!g) return
    try {
      historyRef.current.push(g.getImageData(0, 0, cv.width, cv.height))
      if (historyRef.current.length > 12) historyRef.current.shift()
      setHistoryCount(historyRef.current.length)
      setDirty(true)
    } catch { /* 跨域画布无法快照 */ }
  }, [])

  const undo = useCallback(() => {
    const cv = baseRef.current
    const snap = historyRef.current.pop()
    if (!cv || !snap) return
    cv.getContext('2d')?.putImageData(snap, 0, 0)
    if (historyRef.current.length === 0) setDirty(false)
    setHistoryCount(historyRef.current.length)
  }, [])

  const save = useCallback(async () => {
    const cv = baseRef.current
    if (!cv) return
    setBusy(true)
    try {
      const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('导出失败'))), 'image/png'))
      // 编辑产出留在浏览器本地（blob URL），不上传服务器：
      // 编辑是纯前端 canvas 操作，产出通常只是「拿去当输入」或「下载」，
      // 没必要占服务器磁盘。真正要用作生成输入时，由「用作输入」按需上传。
      const newUrl = URL.createObjectURL(blob)
      onProduced({ url: newUrl, kind: 'image', label: label ? `${label}·编辑` : '编辑结果', fromUrl: url })
      message.success('已生成编辑结果（本地）')
      setDirty(false)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }, [onProduced, message, label, url])

  return (
    <div className="flex h-full min-h-0">
      {/* ===== 左侧工具栏 ===== */}
      <div className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-black/8 bg-black/[0.03] py-2 aigc-hub-scrollbar">
        {TOOLS.map((t) => (
          <Tooltip key={t.id} title={t.label} placement="right">
            <button
              className={`grid size-10 place-items-center rounded-lg text-[16px] transition ${tool === t.id ? 'bg-accent text-white shadow-sm' : 'text-black/60 hover:bg-accent-soft hover:text-accent'}`}
              onClick={() => setTool(tool === t.id ? null : t.id)}
            >
              {t.icon}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* ===== 中部：画布工作区（网格底） ===== */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={stageRef} className="editor-grid relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 aigc-hub-scrollbar">
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/70">
              <AnimatedLogo size={52} />
              <span className="text-xs text-text-secondary">图片加载中…</span>
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-white/85">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="图片加载失败，可能链接已失效" />
            </div>
          )}
          <div className={`relative shrink-0 shadow-[0_4px_24px_rgba(0,0,0,0.18)] ${loading || loadError ? 'opacity-0' : ''}`} style={{ width: disp.w || undefined, height: disp.h || undefined }}>
            <canvas ref={baseRef} className="block select-none" style={{ width: disp.w || 'auto', height: disp.h || undefined }} />
            {tool && nat.w > 0 && disp.w > 0 && (
              <ToolOverlay tool={tool} baseRef={baseRef} nat={nat} imgRef={imgRef} pushHistory={pushHistory} message={message} setTool={setTool} onApplied={() => setDirty(true)} setNat={setNat} srcUrl={url} />
            )}
          </div>
        </div>
        {/* 底部状态条 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-black/8 bg-white/70 px-3 py-1.5 text-[11px] text-black/45">
          <span>{nat.w > 0 ? `${nat.w} × ${nat.h}` : '加载中…'}</span>
          <span className="text-black/25">|</span>
          <span>{tool ? `当前工具：${TOOLS.find((t) => t.id === tool)?.label}` : '选择左侧工具开始编辑'}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="small" icon={<UndoOutlined />} disabled={historyCount === 0} onClick={undo}>撤销</Button>
            <Tooltip title="下载原图"><a href={url} download target="_blank" rel="noreferrer"><Button size="small" icon={<DownloadOutlined />} /></a></Tooltip>
            <Button size="small" type="primary" icon={busy ? <LoadingOutlined /> : <CheckOutlined />} loading={busy} disabled={!dirty} onClick={() => void save()}>保存</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 工具交互层：每个工具的取参 + 应用逻辑（覆盖在 base canvas 上） =====
function ToolOverlay({ tool, baseRef, nat, pushHistory, message, setTool, onApplied, setNat, srcUrl }: {
  tool: ToolId
  baseRef: React.RefObject<HTMLCanvasElement | null>
  nat: { w: number; h: number }
  imgRef: React.RefObject<HTMLImageElement | null>
  pushHistory: () => void
  message: ImageEditorProps['message']
  setTool: (t: ToolId | null) => void
  onApplied: () => void
  setNat: (n: { w: number; h: number }) => void
  srcUrl: string
}) {
  // 框选通用状态（crop/mosaic/cleanup）
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  // 涂鸦
  const [brush, setBrush] = useState(6)
  const [color, setColor] = useState('#7d50e0')
  const drawingRef = useRef(false)
  const strokeRef = useRef<Array<{ x: number; y: number }>>([])
  // 文字
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(Math.round(48))
  const [textColor, setTextColor] = useState('#ffffff')
  // 贴图/画中画
  const stickerRef = useRef<HTMLImageElement | null>(null)
  const [stickerReady, setStickerReady] = useState(false)
  const [stickerScale, setStickerScale] = useState(30)
  // 边框
  const [borderW, setBorderW] = useState(24)
  const [borderColor, setBorderColor] = useState('#7d50e0')
  // 水印
  const [wmText, setWmText] = useState(`@${ORG.name.replace(/\s/g, '')}`)
  const [wmSize, setWmSize] = useState(28)
  const [wmOpacity, setWmOpacity] = useState(25)
  // AI 消水印
  const [cleaning, setCleaning] = useState(false)

  const cv = baseRef.current

  const toNatPt = (e: { clientX: number; clientY: number }) => {
    if (!cv) return { x: 0, y: 0 }
    const b = cv.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(nat.w, ((e.clientX - b.left) / b.width) * nat.w)),
      y: Math.max(0, Math.min(nat.h, ((e.clientY - b.top) / b.height) * nat.h)),
    }
  }

  /**
   * 把 base 画布内容 + 变换导出为新 base 内容。
   * 关键坑：重设 canvas.width/height 会清空位图，clearRect 也会清空。
   * 所以必须先把原图快照成 src，draw 回调只允许用传入的 src 当原图；
   * 若回调里再去读 cv，拿到的就是已清空的画布（表现为「一操作图片就丢失」）。
   */
  const commit = (
    draw: (g: CanvasRenderingContext2D, args: { w: number; h: number; src: HTMLCanvasElement }) => void,
    newW?: number,
    newH?: number,
  ) => {
    if (!cv) return
    pushHistory()
    const src = document.createElement('canvas')
    src.width = cv.width
    src.height = cv.height
    src.getContext('2d')!.drawImage(cv, 0, 0)
    if (newW) cv.width = newW
    if (newH) cv.height = newH
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, cv.width, cv.height)
    draw(g, { w: cv.width, h: cv.height, src })
    onApplied()
  }

  // ===== 各工具 UI =====
  const boxStyle = 'flex flex-wrap items-center gap-2 rounded-lg border border-black/8 bg-white/90 px-3 py-2 shadow-sm'

  if (tool === 'crop' || tool === 'mosaic' || tool === 'cleanup') {
    const label = { crop: '应用裁剪', mosaic: '应用马赛克', cleanup: 'AI 去除' }
    return (
      <>
        {tool !== 'cleanup' && (
          <div
            className="absolute inset-0 cursor-crosshair"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              const p = toNatPt(e)
              dragRef.current = p
              setRect({ x: p.x, y: p.y, w: 0, h: 0 })
              ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (!dragRef.current) return
              const p = toNatPt(e)
              setRect({ x: Math.min(dragRef.current.x, p.x), y: Math.min(dragRef.current.y, p.y), w: Math.abs(p.x - dragRef.current.x), h: Math.abs(p.y - dragRef.current.y) })
            }}
            onPointerUp={() => {
              dragRef.current = null
              setRect((r) => (r && r.w > 6 && r.h > 6 ? r : null))
            }}
          />
        )}
        {rect && (
          <div
            className="pointer-events-none absolute border-2 border-accent bg-accent/10"
            style={{ left: `${(rect.x / nat.w) * 100}%`, top: `${(rect.y / nat.h) * 100}%`, width: `${(rect.w / nat.w) * 100}%`, height: `${(rect.h / nat.h) * 100}%` }}
          >
            <span className="absolute -top-5 left-0 rounded bg-accent px-1 text-[10px] text-white">{Math.round(rect.w)}×{Math.round(rect.h)}</span>
          </div>
        )}
        {(rect || tool === 'cleanup') && (
          <div style={{ right: 8, top: 8 }} className="absolute">
            <div className="flex items-center gap-1.5">
              <Button size="small" icon={<CloseOutlined />} onClick={() => { setRect(null); setTool(null) }}>取消</Button>
              <Button
                size="small" type="primary" icon={cleaning ? <LoadingOutlined /> : <CheckOutlined />} loading={cleaning} disabled={!rect && tool !== 'cleanup'}
              onClick={async () => {
                if (tool === 'crop' && rect) {
                  commit((g, { src }) => {
                    // 裁剪：从原图快照取选区画到新尺寸画布
                    g.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
                  }, Math.round(rect.w), Math.round(rect.h))
                  setNat({ w: Math.round(rect.w), h: Math.round(rect.h) })
                  setRect(null)
                  setTool(null)
                  message.success('已裁剪')
                } else if (tool === 'mosaic' && rect) {
                  commit((g, { src }) => {
                    // 像素化选中区域
                    const px = Math.max(8, Math.round(Math.min(rect.w, rect.h) / 12))
                    const tmp = document.createElement('canvas')
                    tmp.width = Math.max(1, Math.ceil(rect.w / px))
                    tmp.height = Math.max(1, Math.round(rect.h / px))
                    const tg = tmp.getContext('2d')!
                    tg.imageSmoothingEnabled = true
                    tg.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, tmp.width, tmp.height)
                    // 先把原图整体铺回，再叠上马赛克块
                    g.drawImage(src, 0, 0)
                    g.imageSmoothingEnabled = false
                    g.drawImage(tmp, 0, 0, tmp.width, tmp.height, rect.x, rect.y, rect.w, rect.h)
                    g.imageSmoothingEnabled = true
                  })
                  setRect(null)
                  setTool(null)
                  message.success('已打码')
                } else if (tool === 'cleanup' && rect) {
                  // AI 消水印：标注图（框区域画品红）→ /api/image/cleanup
                  setCleaning(true)
                  try {
                    const marked = document.createElement('canvas')
                    marked.width = cv!.width
                    marked.height = cv!.height
                    const mg = marked.getContext('2d')!
                    mg.drawImage(cv!, 0, 0)
                    mg.fillStyle = 'rgba(255,0,144,0.55)'
                    mg.fillRect(rect.x, rect.y, rect.w, rect.h)
                    mg.strokeStyle = '#ff0090'
                    mg.lineWidth = Math.max(3, nat.w / 300)
                    mg.strokeRect(rect.x, rect.y, rect.w, rect.h)
                    const blob = await new Promise<Blob>((res) => marked.toBlob((b) => res(b!), 'image/png'))
                    const markedUrl = await uploadAssetBlob(blob, `mark-${Date.now()}.png`, 'image/png')
                    const res = await fetch('/api/image/cleanup', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ imageUrl: srcUrl, markedUrl }),
                    })
                    const j = await res.json().catch(() => null)
                    if (res.ok && j?.success && j?.data?.url) {
                      // 载入结果为新 base
                      const img = new Image()
                      img.crossOrigin = 'anonymous'
                      await new Promise<void>((r, rej) => { img.onload = () => r(); img.onerror = () => rej(new Error('结果加载失败')); img.src = j.data.url })
                      if (cv) {
                        pushHistory()
                        cv.width = img.naturalWidth
                        cv.height = img.naturalHeight
                        cv.getContext('2d')!.drawImage(img, 0, 0)
                        onApplied()
                      }
                      setNat({ w: img.naturalWidth, h: img.naturalHeight })
                      setRect(null)
                      setTool(null)
                      message.success('已去除标注区域')
                    } else message.error(j?.message || 'AI 消水印失败')
                  } catch (e) {
                    message.error(e instanceof Error ? e.message : 'AI 消水印失败')
                  } finally {
                    setCleaning(false)
                  }
                }
              }}
            >{label[tool]}</Button>
            </div>
          </div>
        )}
        {tool === 'cleanup' && (
          <div className="absolute bottom-2 left-2 rounded-lg bg-black/60 px-3 py-1.5 text-[11px] text-white">拖拽框选要去除的水印/物体 → 点「AI 去除」（按生图模型扣积分）</div>
        )}
      </>
    )
  }

  if (tool === 'rotate') {
    return (
      <div className="absolute right-2 top-2" style={{}}>
        <div className={boxStyle}>
          <Button size="small" icon={<RotateRightOutlined />} onClick={() => { commit((g, { w, src }) => {
            // 旋转 90°：新画布宽高互换，把原图快照旋转后画入
            g.translate(w, 0)
            g.rotate(Math.PI / 2)
            g.drawImage(src, 0, 0)
          }, nat.h, nat.w); setNat({ w: nat.h, h: nat.w }); message.success('已旋转 90°') }}>顺时针 90°</Button>
        </div>
      </div>
    )
  }

  if (tool === 'flip') {
    return (
      <div className="absolute right-2 top-2">
        <div className={boxStyle}>
          <Button size="small" icon={<SwapOutlined />} onClick={() => {
            commit((g, { w, src }) => {
              g.translate(w, 0)
              g.scale(-1, 1)
              g.drawImage(src, 0, 0)
            })
            message.success('已水平镜像')
          }}>水平镜像</Button>
        </div>
      </div>
    )
  }

  if (tool === 'draw') {
    return (
      <>
        <div
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={(e) => {
            drawingRef.current = true
            pushHistory()
            const p = toNatPt(e)
            strokeRef.current = [p]
            ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drawingRef.current || !cv) return
            const p = toNatPt(e)
            const g = cv.getContext('2d')!
            const prev = strokeRef.current[strokeRef.current.length - 1]
            g.strokeStyle = color
            g.lineWidth = brush
            g.lineCap = 'round'
            g.lineJoin = 'round'
            g.beginPath()
            g.moveTo(prev.x, prev.y)
            g.lineTo(p.x, p.y)
            g.stroke()
            strokeRef.current.push(p)
          }}
          onPointerUp={() => { drawingRef.current = false; onApplied() }}
        />
        <div className="absolute right-2 top-2">
          <div className={boxStyle}>
            <span className="text-[11px] text-black/50">粗细</span>
            <Slider value={brush} min={1} max={40} onChange={setBrush} className="!w-20 !m-0" tooltip={{ open: false }} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="size-6 cursor-pointer rounded border border-black/10" />
          </div>
        </div>
      </>
    )
  }

  if (tool === 'text') {
    return (
      <div className="absolute inset-0 cursor-text" onClick={(e) => {
        if (!text.trim() || !cv) return
        const p = toNatPt(e)
        commit((g, { src }) => {
          g.drawImage(src, 0, 0)
          g.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
          g.fillStyle = textColor
          g.shadowColor = 'rgba(0,0,0,0.45)'
          g.shadowBlur = fontSize / 6
          g.textBaseline = 'top'
          g.fillText(text, p.x, p.y)
        })
        message.success('已添加文字')
      }}>
        <div className="absolute right-2 top-2 cursor-default" onClick={(e) => e.stopPropagation()}>
          <div className={boxStyle}>
            <Input size="small" placeholder="输入文字" value={text} onChange={(e) => setText(e.target.value)} className="!w-32" />
            <span className="text-[11px] text-black/50">字号</span>
            <InputNumber size="small" min={8} max={400} value={fontSize} onChange={(v) => setFontSize(v || 24)} className="!w-16" />
            <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="size-6 cursor-pointer rounded border border-black/10" />
          </div>
          {text.trim() && <div className="mt-1 text-center text-[11px] text-black/45">点击图上位置放置文字</div>}
        </div>
      </div>
    )
  }

  if (tool === 'sticker' || tool === 'pip') {
    const pick = async (file: File) => {
      const img = new Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => { stickerRef.current = img; setStickerReady(true); message.info('图片已就绪，点击图上位置放置') }
      img.src = objectUrl
    }
    return (
      <>
        <div className="absolute inset-0 cursor-crosshair" onClick={(e) => {
          const img = stickerRef.current
          if (!img || !cv) return
          const p = toNatPt(e)
          const targetW = (stickerScale / 100) * nat.w
          const scale = targetW / img.naturalWidth
          const w2 = targetW
          const h2 = img.naturalHeight * scale
          commit((g, { src }) => {
            g.drawImage(src, 0, 0)
            if (tool === 'pip') {
              // 画中画：白边框 + 阴影
              g.save()
              g.shadowColor = 'rgba(0,0,0,0.35)'
              g.shadowBlur = 12
              g.fillStyle = '#ffffff'
              g.fillRect(p.x - 4, p.y - 4, w2 + 8, h2 + 8)
              g.restore()
              g.drawImage(img, p.x, p.y, w2, h2)
            } else {
              g.drawImage(img, p.x, p.y, w2, h2)
            }
          })
          message.success(tool === 'pip' ? '已添加画中画' : '已添加贴图')
        }}>
          <div className="absolute right-2 top-2 cursor-default" onClick={(ev) => ev.stopPropagation()}>
            <div className={boxStyle}>
              <label className="cursor-pointer rounded border border-black/15 px-2 py-1 text-[11px] hover:border-accent hover:text-accent">
                选择图片
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f) }} />
              </label>
              <span className="text-[11px] text-black/50">宽度 {stickerScale}%</span>
              <Slider value={stickerScale} min={5} max={100} onChange={setStickerScale} className="!w-24 !m-0" tooltip={{ open: false }} />
            </div>
            {stickerReady && <div className="mt-1 text-center text-[11px] text-black/45">点击图上位置放置</div>}
          </div>
        </div>
      </>
    )
  }

  if (tool === 'border') {
    return (
      <div className="absolute right-2 top-2">
        <div className={boxStyle}>
          <span className="text-[11px] text-black/50">边宽</span>
          <InputNumber size="small" min={2} max={200} value={borderW} onChange={(v) => setBorderW(v || 12)} className="!w-16" />
          <input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} className="size-6 cursor-pointer rounded border border-black/10" />
          <Button size="small" type="primary" onClick={() => {
            const bw = Math.round((borderW / 100) * Math.min(nat.w, nat.h)) + 2
            commit((g, { src }) => {
              g.fillStyle = borderColor
              g.fillRect(0, 0, src.width + bw * 2, src.height + bw * 2)
              g.drawImage(src, bw, bw)
            }, nat.w + bw * 2, nat.h + bw * 2)
            setNat({ w: nat.w + bw * 2, h: nat.h + bw * 2 })
            message.success('已加边框')
          }}>应用</Button>
        </div>
      </div>
    )
  }

  if (tool === 'watermark') {
    const apply = () => {
      commit((g, { w, h, src }) => {
        g.drawImage(src, 0, 0)
        g.font = `500 ${wmSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
        g.fillStyle = `rgba(255,255,255,${wmOpacity / 100})`
        g.save()
        g.translate(w / 2, h / 2)
        g.rotate(-Math.PI / 9)
        const met = g.measureText(wmText)
        const stepX = met.width + wmSize * 2.2
        const stepY = wmSize * 3.2
        for (let y = -h; y < h * 1.5; y += stepY) {
          for (let x = -w; x < w * 1.5; x += stepX) {
            g.fillText(wmText, x - w / 2, y)
          }
        }
        g.restore()
      })
      message.success('已加水印')
    }
    return (
      <div className="absolute right-2 top-2">
        <div className={boxStyle}>
          <Input size="small" value={wmText} onChange={(e) => setWmText(e.target.value)} className="!w-24" placeholder="水印文字" />
          <span className="text-[11px] text-black/50">字号</span>
          <InputNumber size="small" min={8} max={200} value={wmSize} onChange={(v) => setWmSize(v || 28)} className="!w-16" />
          <span className="text-[11px] text-black/50">浓度</span>
          <Slider value={wmOpacity} min={5} max={80} onChange={setWmOpacity} className="!w-20 !m-0" tooltip={{ open: false }} />
          <Button size="small" type="primary" disabled={!wmText.trim()} onClick={apply}>平铺水印</Button>
        </div>
      </div>
    )
  }

  return null
}
