'use client'

import { Tag } from 'antd'
import type { ReactNode } from 'react'

/**
 * 品牌紫 Tag：统一替代散落的 AntD `<Tag color="purple">`（默认紫 #722ed1 与品牌紫 #7d50e0 不一致）。
 * 用品牌色 token，与全站 accent 强调一致。
 */
export function BrandTag({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <Tag className={`!text-accent !border-accent !bg-accent-light ${className}`}>{children}</Tag>
  )
}
