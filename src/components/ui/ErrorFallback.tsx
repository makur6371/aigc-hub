'use client'

import { useState } from 'react'
import Link from 'next/link'

/**
 * 全站**唯一**的错误兜底实现（Q-D44）。
 *
 * ===== 为什么必须有它 =====
 * 这之前 `src/app` 下没有任何 `error.tsx` / `global-error.tsx` / `not-found.tsx`。
 * Next.js 的行为是：任意一段路由渲染期抛错 → 整页被打回默认错误页（用户看到的是一句
 * 「Something went wrong」的裸文本，没有任何出口）；404 则是 Next 默认页，连品牌都没有。
 * 对画布 / 工具台这类重状态页面尤其糟：一崩，用户第一反应是「我刚才生成的东西是不是没了」。
 *
 * ===== 这份实现刻意保持的三条约束 =====
 * 1. **不依赖 antd、不依赖图标库**：兜底组件的职责是在「别的东西都坏了」的时候还能渲染。
 *    多引一个 provider 就多一条让它自己崩掉的路径 —— 那比没有兜底更糟，因为错误会被吞成白屏。
 *    代价是视觉与 antd 组件不是同一套控件，这里用站内既有的品牌色与圆角语言补齐。
 * 2. **必须给出出口**：重试（`reset`）+ 回到可用页面。只有一句「出错了」的兜底等于没兜。
 * 3. **必须说清「你的成果没丢」**：这是用户此刻唯一的焦虑，而它恰好是真的 ——
 *    成果与余额都在服务端，渲染崩溃动不到它们。不写这句，用户会以为平台吃了他的图。
 *
 * 错误详情默认折叠：普通用户不需要看 stack，但要能让客服/管理员一眼拿到原始信息；
 * 复制失败时降级成「可手动选中」，而不是静默什么都不发生。
 */

/**
 * 由路径推出「崩的是哪一块」。
 *
 * 单独放这里而不是每个 `error.tsx` 各写一份：告诉用户具体是哪一块出问题
 * （而不是「网站坏了」）是这类兜底最有价值的一句话，写散了就会各处口径不一。
 */
const SCOPE_BY_FIRST_SEGMENT: Record<string, string> = {
  canvas: '画布',
  agent: '智能体',
  tools: '工具箱',
  gallery: '作品广场',
  prompts: '提示词库',
  user: '个人中心',
  help: '帮助中心',
  admin: '管理后台',
  pricing: '定价页',
  product: '产品页',
  about: '关于页',
  faq: '常见问题',
  mcp: 'MCP 接入页',
  login: '登录页',
  register: '注册页',
}

export function scopeFromPathname(pathname?: string | null): string | undefined {
  const first = (pathname || '').split('/').filter(Boolean)[0]
  return first ? SCOPE_BY_FIRST_SEGMENT[first] : undefined
}

type ErrorFallbackProps = {
  error: Error & { digest?: string }
  /** Next.js 注入的重试函数：重新渲染出错的那一段，而不是整页刷新 */
  reset?: () => void
  /** 出错的位置（画布 / 工具台 / 后台…），让用户知道崩的是哪一块、其他块还能用 */
  scope?: string
  /** 兜底跳转目标：后台的错误不该把人丢到前台首页 */
  homeHref?: string
  homeLabel?: string
}

function detailText(error: Error & { digest?: string }, scope?: string): string {
  const lines = [
    `位置：${scope || '页面'}`,
    `信息：${error?.message || '（生产构建下浏览器侧不暴露错误文本，请凭编号排查）'}`,
    `编号：${error?.digest || '-'}`,
    `时间：${new Date().toLocaleString('zh-CN')}`,
    `地址：${typeof window === 'undefined' ? '-' : window.location.href}`,
  ]
  return lines.join('\n')
}

export function ErrorFallback({
  error,
  reset,
  scope,
  homeHref = '/',
  homeLabel = '回首页',
}: ErrorFallbackProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'manual'>('idle')
  const detail = detailText(error, scope)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail)
      setCopyState('ok')
    } catch {
      // 非安全上下文 / 用户未授权时 clipboard 会抛错：
      // 必须降级成「能看到并手动选中」，而不是假装复制成功。
      setCopyState('manual')
    }
  }

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-white p-7 shadow-sm sm:p-9">
        <div className="flex items-start gap-4">
          <div className="brand-gradient-bg flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl font-bold text-white">
            !
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">
              {scope ? `${scope}暂时打不开` : '这个页面暂时打不开'}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              是这一块的页面出问题了，<strong className="font-medium text-foreground">你的账号、积分余额和已生成的成果都还在服务器上</strong>
              ，不会因为这次报错而丢失。可以先点「重试」；反复出现的话，把下面的错误信息发给客服。
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {reset && (
            <button
              type="button"
              onClick={reset}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-2 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              重试
            </button>
          )}
          <Link
            href={homeHref}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:border-accent-border hover:text-accent"
          >
            {homeLabel}
          </Link>
        </div>

        <details className="mt-6 rounded-lg bg-accent-soft p-4">
          <summary className="cursor-pointer select-none text-sm text-text-muted">
            查看错误详情（反馈时请附上）
          </summary>
          <pre className="mt-3 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text-muted">
            {detail}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-accent-border bg-white px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent-light"
            >
              {copyState === 'ok' ? '已复制' : '复制错误信息'}
            </button>
            {copyState === 'manual' && (
              <span className="text-xs text-warning-strong">
                浏览器不允许自动复制，请长按/选中的上面那段文字手动复制
              </span>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}
