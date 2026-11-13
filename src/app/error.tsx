'use client'

import { ErrorFallback } from '@/components/ui/ErrorFallback'

/**
 * 根段错误边界（Q-D44）：兜住没有自己 `error.tsx` 的顶层路由
 * （登录、注册、微信回调、预览页等），以及任何更深边界没接住的渲染错误。
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorFallback error={error} reset={reset} homeHref="/" homeLabel="回首页" />
}
