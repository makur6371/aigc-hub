import type { Metadata } from 'next'
import { AntdRegistry } from '@/components/providers/AntdRegistry'
import './globals.css'

export const metadata: Metadata = {
  title: 'AIGC Hub',
  description: '自托管的图像、视频、Agent 与画布创作工作台。',
  icons: { icon: '/logo.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN" className="h-full antialiased"><body className="min-h-full"><AntdRegistry>{children}</AntdRegistry></body></html>
}
