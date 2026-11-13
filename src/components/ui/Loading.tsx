'use client'

import { AnimatedLogo } from './AnimatedLogo'

export interface LoadingProps {
  tip?: string
  size?: number
  fullScreen?: boolean
  className?: string
  /** 显示品牌名字标（大尺寸仪式感场景用，如根 loading / 登录页 / 画布全屏） */
  showWordmark?: boolean
}

export function Loading({ tip, size = 64, fullScreen = false, className = '', showWordmark = false }: LoadingProps) {
  const content = (
    <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
      <AnimatedLogo size={size} showWordmark={showWordmark} />
      {tip && <span className="text-sm text-text-secondary">{tip}</span>}
    </div>
  )

  if (fullScreen) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-white/80 z-50">
        {content}
      </div>
    )
  }

  return content
}
