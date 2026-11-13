'use client'

import { Shimmer } from '@/components/ui/Shimmer'

/**
 * 媒体列表骨架屏（图片/视频/音频「我的记录」页共用）。
 *
 * ===== 为什么需要 =====
 * 这三页的加载态此前是一个居中的转圈 + 「加载中…」文案，页面主体是空的 ——
 * 内容回来时整页"啪"地铺开，视觉跳变大、也显得慢。骨架屏预先铺出卡片轮廓，
 * 内容到达时原地替换，观感上是"填充"而不是"跳变"。
 *
 * 卡片结构与真实卡片对齐（缩略图区 aspect-video + 底部两行文字），
 * 所以替换时位置不会移动。
 */
export function MediaGridSkeleton({ count = 6 }: { count?: number; kind?: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="加载中">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-border bg-card-bg">
          {/* 缩略图区：与真实卡片同样的 aspect-video */}
          <Shimmer className="aspect-video w-full !rounded-none" />
          <div className="space-y-2 p-3">
            <Shimmer className="h-3.5 w-4/5" />
            <Shimmer className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
