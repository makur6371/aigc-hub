'use client'

// ===== 图片生成中的「网格渐显」占位 =====
//
// 灵感来自 rareui 的 Grid Reveal：AI 图未就绪时先铺一层网格骨架，
// 图到达后网格淡出、真图淡入。适配本站微紫玻璃风格（accent 色 + 圆角）。
//
// 用途：成果区排队位、工具面板结果缩略图、Agent 产出占位。

import { useState, useEffect } from 'react'

interface GridRevealProps {
  /** 真图地址；为空表示还没好，显示网格 */
  src?: string | null
  alt?: string
  className?: string
  /** 网格单元尺寸（px），越小越密 */
  cell?: number
}

export function GridReveal({ src, alt = '', className = '', cell = 16 }: GridRevealProps) {
  // 记录「已就绪的 src」：图换新地址时自然回到未加载态（不需要在 effect 里同步 setState）。
  const [readySrc, setReadySrc] = useState<string | null>(null)
  const [showImg, setShowImg] = useState(false)
  const loaded = !!src && readySrc === src

  useEffect(() => {
    if (!src) {
      const t = window.setTimeout(() => { setReadySrc(null); setShowImg(false) }, 0)
      return () => window.clearTimeout(t)
    }
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setReadySrc(src) }
    img.onerror = () => { if (alive) setReadySrc(null) }
    img.src = src
    return () => { alive = false; img.onload = null; img.onerror = null }
  }, [src])

  // 图加载好 → 让网格先收一下，再显示图片（营造"揭示"感）
  useEffect(() => {
    if (!loaded) return
    const t = window.setTimeout(() => setShowImg(true), 180)
    return () => window.clearTimeout(t)
  }, [loaded])

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* 网格骨架：紫调细线，带缓慢呼吸 */}
      {!showImg && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{
            backgroundColor: 'var(--surface)',
            backgroundImage:
              'linear-gradient(to right, var(--accent-border) 1px, transparent 1px), linear-gradient(to bottom, var(--accent-border) 1px, transparent 1px)',
            backgroundSize: `${cell}px ${cell}px`,
            opacity: 0.7,
          }}
        />
      )}
      {src && loaded && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          onLoad={() => setReadySrc(src)}
          className={`relative size-full object-cover transition-opacity duration-500 ${showImg ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  )
}
