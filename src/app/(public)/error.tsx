'use client'

import { usePathname } from 'next/navigation'
import { ErrorFallback, scopeFromPathname } from '@/components/ui/ErrorFallback'

/** 公开营销页错误边界（Q-D44）：这些页面对未登录访客开放，崩了就是直接漏客户。 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const pathname = usePathname()
  return <ErrorFallback error={error} reset={reset} scope={scopeFromPathname(pathname)} homeHref="/" homeLabel="回首页" />
}
