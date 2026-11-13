'use client'

import type { ReactNode } from 'react'

/**
 * 流光骨架屏（shimmer skeleton）—— 品牌紫色调的高光扫过。
 * （本文件位于 ui/，fx 目录通过 re-export 暴露；见 ui/fx/index.ts）
 *
 * ===== 为什么需要 =====
 * 站内加载态此前只有两种：纯灰占位 `<div className="bg-black/[0.04]" />` 或
 * AntD `<Skeleton />`（灰条、无品牌感、不支持任意形状）。列表/卡片/图片位
 * 用它们会显得"页面卡住了"。流光骨架能明确传达"正在加载"且与紫调语言一致。
 *
 * ===== 视觉 =====
 * 底色是低对比的紫灰，一道透明→白→透明的高光从左到右循环扫过（1.6s）。
 * 高光用背景渐变位移实现（`background-position`），不用 `filter`/`mask`，
 * 因此在低端设备上也不卡；`prefers-reduced-motion` 下停在静态底色。
 *
 * 用法：
 *   <Shimmer className="h-4 w-32 rounded" />
 *   <Shimmer circle size={40} />
 */
export function Shimmer({
  className = '',
  circle = false,
  size,
  children,
}: {
  className?: string
  /** 圆形（头像位）：忽略 className 里的 rounded，用 aspect-square + rounded-full */
  circle?: boolean
  /** 圆形的边长（px） */
  size?: number
  children?: ReactNode
}) {
  const shape = circle ? 'rounded-full shrink-0' : 'rounded-md'
  const dim = circle && size ? { width: size, height: size } : undefined
  return (
    <span
      aria-hidden
      style={dim}
      className={`shimmer-surface inline-block ${shape} ${className}`}
    >
      {children}
    </span>
  )
}

/** 多行文本骨架：按比例宽度递减，更像真实段落 */
export function ShimmerLines({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  // 宽度档位：非末行满宽，末行 3/4 —— 固定档位，避免每次渲染宽度跳动
  return (
    <span className={`block space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={`block ${i === lines - 1 && lines > 1 ? 'w-3/4' : 'w-full'}`}>
          <Shimmer className="h-3 block" />
        </span>
      ))}
    </span>
  )
}
