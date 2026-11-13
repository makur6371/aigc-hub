'use client'

import { usePathname } from 'next/navigation'
import { ErrorFallback, scopeFromPathname } from '@/components/ui/ErrorFallback'

/**
 * 应用内错误边界（Q-D44）。
 *
 * 放在 (app) 这一段而不是只做根边界，是为了让侧边栏壳子继续可用：
 * 画布或工具台崩掉时用户仍能导航去别的页面，而不是整站变白屏。
 * scope 由路径推出来 —— 告诉用户「是画布打不开」比「网站坏了」有用得多。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const pathname = usePathname()
  return <ErrorFallback error={error} reset={reset} scope={scopeFromPathname(pathname)} homeHref="/agent" homeLabel="去智能体" />
}
