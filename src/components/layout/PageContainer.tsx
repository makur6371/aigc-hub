import React from 'react'

export function PageContainer({ children, maxWidth = '1600px', contentClassName = '', disablePadding = false }: { children: React.ReactNode; maxWidth?: string; contentClassName?: string; disablePadding?: boolean }) {
  return (
    <div className={`h-full overflow-y-auto aigc-hub-scrollbar ${disablePadding ? '' : 'aigc-hub-page-pad md:px-6 md:py-6'}`}>
      <div className={`mx-auto ${contentClassName}`} style={{ maxWidth }}>{children}</div>
    </div>
  )
}
