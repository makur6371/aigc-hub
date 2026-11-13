'use client'

// 画布纯展示子组件（无业务状态，仅受 props 驱动），从 page.tsx 拆出保持单文件可读
import { useState, useMemo, useRef, useEffect } from 'react'
import { Modal, Button, Typography } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { nodeWidthFor, estimateNodeHeight, categoryColors } from '@/lib/canvas-utils'
import { resolveCssColor } from '@/lib/css-color'

import type { CanvasNode, Viewport } from '@/lib/canvas-utils'
import { getAllNodeDocsMarkdown } from '@/lib/node-docs'

const { Text } = Typography

// 节点帮助 Modal:展示所有节点文档,一键复制给 AI
export function NodeDocsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const md = getAllNodeDocsMarkdown()
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* */ }
  }
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="画布节点帮助"
      width={760}
      footer={[
        <Button key="copy" icon={copied ? <CheckOutlined /> : <CopyOutlined />} type="primary" onClick={handleCopy}>
          {copied ? '已复制' : '复制文档给 AI'}
        </Button>,
        <Button key="close" onClick={onClose}>关闭</Button>,
      ]}
    >
      <div className="max-h-[65vh] overflow-y-auto aigc-hub-scrollbar">
        <div className="mb-3">
          <Text className="text-xs text-text-secondary">
            画布有 {md.split('### ').length - 1} 个节点。每个节点有输入/输出端口,连线即数据流。选中节点后可用方向键精准移动。
          </Text>
        </div>
        <div className="bg-surface rounded-lg p-4 text-xs leading-relaxed space-y-4">
          {md.split('\n## ').slice(1).map((section, si) => {
            const title = section.split('\n')[0]
            const items = section.split('\n### ').slice(1)
            return (
              <div key={si}>
                <Text strong className="text-sm block mb-2">{title}</Text>
                {items.map((item, ii) => {
                  const lines = item.split('\n')
                  const name = lines[0]
                  const descIdx = lines.findIndex((l) => !l.startsWith('`') && l.length > 0 && !l.startsWith('**'))
                  const desc = descIdx > 0 ? lines[descIdx] : ''
                  return (
                    <div key={ii} className="mb-3 pl-2 border-l-2 border-surface-pressed">
                      <Text strong className="text-xs">{name}</Text>
                      {desc && <div className="text-text-muted mt-0.5">{desc}</div>}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

// 画布小地图：拖动即跳转/平移视野，仅受节点/视口/容器尺寸驱动
export function Minimap({
  nodes,
  viewport,
  containerSize,
  onViewportChange,
}: {
  nodes: CanvasNode[]
  viewport: Viewport
  containerSize: { width: number; height: number }
  onViewportChange: (v: Viewport) => void
}) {
  const mapWidth = 160
  const mapHeight = 120
  // 视野框尺寸（世界坐标）：当前视口缩放后能看到的范围
  const viewW = containerSize.width / (viewport.scale || 1)
  const viewH = containerSize.height / (viewport.scale || 1)

  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return {
        minX: -viewport.x / (viewport.scale || 1),
        minY: -viewport.y / (viewport.scale || 1),
        maxX: -viewport.x / (viewport.scale || 1) + viewW,
        maxY: -viewport.y / (viewport.scale || 1) + viewH,
      }
    }
    // 节点实际高度：有 info 的按端口数估，无 info 用默认；保证矩形与真实卡片比例一致
    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const rights = nodes.map((n) => n.x + nodeWidthFor(n.type))
    const bottoms = nodes.map((n) => n.y + estimateNodeHeight(undefined))
    // 边界包含视野框，避免拖动时视野框跑出地图
    return {
      minX: Math.min(...xs, -viewport.x / (viewport.scale || 1)),
      minY: Math.min(...ys, -viewport.y / (viewport.scale || 1)),
      maxX: Math.max(...rights, -viewport.x / (viewport.scale || 1) + viewW),
      maxY: Math.max(...bottoms, -viewport.y / (viewport.scale || 1) + viewH),
    }
  }, [nodes, viewW, viewH, viewport])

  const scaleX = mapWidth / Math.max(1, bounds.maxX - bounds.minX)
  const scaleY = mapHeight / Math.max(1, bounds.maxY - bounds.minY)
  const scale = Math.min(scaleX, scaleY)
  const offX = (mapWidth - (bounds.maxX - bounds.minX) * scale) / 2
  const offY = (mapHeight - (bounds.maxY - bounds.minY) * scale) / 2

  // 拖动中每次 setViewport 都触发重渲染，bounds/scale/offX/offY/viewport 随之变化；
  // window 监听闭包会过期 → 用 ref 镜像每帧最新的换算参数
  const geoRef = useRef({ bounds, scale, offX, offY, viewport })
  // 在 effect 里镜像（渲染期写 ref 会触发 react-hooks/refs）；只被 window 事件回调读取
  useEffect(() => {
    geoRef.current = { bounds, scale, offX, offY, viewport }
  })

  // 把画布视口中心对到世界坐标点
  const centerViewportOn = (canvasX: number, canvasY: number, vp: Viewport) => {
    onViewportChange({
      x: containerSize.width / 2 - canvasX * vp.scale,
      y: containerSize.height / 2 - canvasY * vp.scale,
      scale: vp.scale,
    })
  }

  // 按下即居中跳转（原单击行为），按住拖动则连续平移视野
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const g0 = geoRef.current
    centerViewportOn(
      g0.bounds.minX + (e.clientX - rect.left - g0.offX) / g0.scale,
      g0.bounds.minY + (e.clientY - rect.top - g0.offY) / g0.scale,
      g0.viewport
    )

    const move = (ev: PointerEvent) => {
      const g = geoRef.current
      const cx = g.bounds.minX + (ev.clientX - rect.left - g.offX) / g.scale
      const cy = g.bounds.minY + (ev.clientY - rect.top - g.offY) / g.scale
      onViewportChange({
        x: containerSize.width / 2 - cx * g.viewport.scale,
        y: containerSize.height / 2 - cy * g.viewport.scale,
        scale: g.viewport.scale,
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="relative w-[160px] h-[120px] bg-white/90 backdrop-blur rounded-lg shadow-sm border border-border overflow-hidden cursor-grab active:cursor-grabbing touch-none"
      onPointerDown={handlePointerDown}
    >
      <svg width={mapWidth} height={mapHeight}>
        {nodes.map((node) => (
          <rect
            key={node.id}
            x={(node.x - bounds.minX) * scale + offX}
            y={(node.y - bounds.minY) * scale + offY}
            width={Math.max(3, nodeWidthFor(node.type) * scale)}
            height={Math.max(3, estimateNodeHeight(undefined) * scale)}
            fill={resolveCssColor(categoryColors[node.category])}
            opacity={0.8}
            rx={2}
          />
        ))}
        {/* Viewport rect：视野框（世界坐标 → 地图坐标） */}
        <rect
          x={(-viewport.x / (viewport.scale || 1) - bounds.minX) * scale + offX}
          y={(-viewport.y / (viewport.scale || 1) - bounds.minY) * scale + offY}
          width={viewW * scale}
          height={viewH * scale}
          fill="rgba(125,80,224,0.06)"
          stroke="var(--primary)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  )
}

// 商店风格图标（纯 svg，替代 Antd AppstoreOutlined 的字体图标，避免字体未加载时缺字）
export function AppstoreIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <line x1="10" y1="6.5" x2="14" y2="6.5" />
      <line x1="6.5" y1="10" x2="6.5" y2="14" />
    </svg>
  )
}
