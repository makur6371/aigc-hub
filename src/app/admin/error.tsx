'use client'

import { ErrorFallback } from '@/components/ui/ErrorFallback'

/** 后台错误边界（Q-D44）：后台崩了不该把管理员丢到前台首页。 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      scope="管理后台"
      homeHref="/admin/ops"
      homeLabel="回运维面板"
    />
  )
}
