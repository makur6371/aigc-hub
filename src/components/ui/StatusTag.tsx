'use client'

import { Tag } from 'antd'
import type { ReactNode } from 'react'

/**
 * 语义状态 Tag：统一替代散落的 AntD `<Tag color="green/red/orange/blue/gold">`。
 * 颜色走全站 CSS token（--success/--warning/--danger/--primary/--accent），
 * 避免 AntD 默认色绕过主题、与品牌语言割裂。
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'primary' | 'accent' | 'gold'

// 文本与底色的 token 映射：warning/gold 用 deep 保证浅底上的可读性
const TONE_MAIN: Record<StatusTone, string> = {
  success: 'var(--success)',
  warning: 'var(--warning-deep)',
  danger: 'var(--danger)',
  primary: 'var(--primary)',
  accent: 'var(--accent)',
  gold: 'var(--warning-deep)',
}
const TONE_BG: Record<StatusTone, string> = {
  success: 'var(--success-bg)',
  warning: 'var(--warning-bg)',
  danger: 'var(--danger-bg)',
  primary: 'var(--primary-light)',
  accent: 'var(--accent-light)',
  gold: 'var(--warning-bg)',
}

export function StatusTag({
  tone = 'primary',
  icon,
  children,
  className = '',
}: {
  tone?: StatusTone
  icon?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const main = TONE_MAIN[tone]
  return (
    <Tag
      className={className}
      icon={icon}
      style={{ color: main, background: TONE_BG[tone], borderColor: main }}
    >
      {children}
    </Tag>
  )
}
