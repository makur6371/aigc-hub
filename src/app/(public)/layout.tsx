import type { Metadata } from 'next'
import Link from 'next/link'
import { ORG } from '@/lib/site-content'

export const metadata: Metadata = {
  metadataBase: new URL(ORG.url),
  robots: { index: false, follow: false },
}

const NAV = [
  { href: '/', label: '首页' },
  { href: '/gallery', label: '作品广场' },
  { href: '/faq', label: '常见问题' },
]

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full flex flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-white/85 backdrop-blur">
        <div className="mx-auto max-w-5xl px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt={ORG.name} className="w-8 h-8 rounded-lg" />
            <span className="brand-gradient-text text-lg font-bold tracking-wide">
              {ORG.name}
            </span>
          </Link>
          <nav className="hidden sm:flex items-center gap-1" aria-label="主导航">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3.5 py-2 rounded-lg text-sm text-text-secondary hover:text-accent hover:bg-accent-light transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/login"
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-br from-accent to-accent-2 hover:opacity-90 transition-opacity"
          >
            登录
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-12">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-text-secondary">
          <span>
            © 2026 {ORG.name} · {ORG.tagline}
          </span>
          <nav className="flex items-center gap-4" aria-label="页脚导航">
            <Link href="/faq" className="hover:text-accent">常见问题</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
