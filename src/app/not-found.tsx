import Link from 'next/link'
import type { Metadata } from 'next'

/**
 * 全站 404（Q-D44）：此前没有任何 `not-found.tsx`，路径写错时用户看到的是
 * Next 的默认页 —— 没有品牌、没有任何出口，对一个新注册的平台来说就是「这站是不是废了」。
 * 这些链接是按真实使用率挑的，不是随便列导航。
 */
export const metadata: Metadata = {
  title: '页面不存在 — AIGC Hub',
  // 404 不该进索引：否则搜到的是错误页，且会持续污染站长平台的收录数据
  robots: { index: false, follow: true },
}

const LINKS = [
  { href: '/agent', label: '智能体', desc: '一句话让它规划并生成文本、图片、视频' },
  { href: '/canvas', label: '画布', desc: '把多个模型连成可复用的工作流' },
  { href: '/tools', label: '工具箱', desc: '别人调好的现成工具，直接填参数出图' },
  { href: '/gallery', label: '作品广场', desc: '看看站内已经做出了什么' },
  { href: '/model-pricing', label: '积分定价', desc: '查看模型用量配置' },
]

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background px-5 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center gap-4">
          <img src="/logo.svg" alt="AIGC Hub" className="h-12 w-12 rounded-xl" />
          <div>
            <p className="brand-gradient-text text-3xl font-bold leading-none">404</p>
            <p className="mt-2 text-sm text-text-secondary">这个地址下没有页面，可能已被改名或下架。</p>
          </div>
        </div>

        <div className="mt-9 grid gap-3 sm:grid-cols-2">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-xl border border-border bg-white p-4 transition-colors hover:border-accent-border hover:bg-accent-soft"
            >
              <span className="block text-sm font-medium text-foreground">{l.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-text-muted">{l.desc}</span>
            </Link>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap gap-3 text-sm">
          <Link href="/" className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 font-medium text-white transition-opacity hover:opacity-90">
            回首页
          </Link>
          <Link href="/help" className="rounded-lg border border-border px-4 py-2 text-text-secondary transition-colors hover:border-accent-border hover:text-accent">
            帮助中心
          </Link>
        </div>
      </div>
    </div>
  )
}
