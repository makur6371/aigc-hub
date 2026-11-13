'use client'

import { useState } from 'react'

/**
 * 最后一道兜底（Q-D44）：`global-error` 替换的是**根 layout 本身**，
 * 也就是说走到这里时 `globals.css`、Antd registry、客服挂件都可能已经没了。
 * 所以这个文件刻意：
 *   - 自带 `<html>` / `<body>`（Next 要求，否则响应里没有文档根）；
 *   - 全部用内联样式，**不依赖任何 CSS 文件或 provider** —— 依赖它们等于指望
 *     「导致崩溃的那一层还能正常工作」。
 *
 * 这里也解释为什么不能复用 ErrorFallback：那个组件依赖站内 Tailwind 类，
 * 在根 layout 失效的场景下会退化成一屏无样式文本，反而更难看懂。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#faf8fe', color: '#141414', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}>
          <div style={{ maxWidth: 520, width: '100%', background: '#fff', border: '1px solid #ebe4f8', borderRadius: 16, padding: '28px 26px' }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>AIGC Hub 没能加载起来</div>
            <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.7, color: '#595959' }}>
              是站点本身出了问题，<strong style={{ color: '#141414' }}>你的账号、积分余额和已生成的成果都不受影响</strong>。
              刷新或稍后再试通常就能恢复；如果一直这样，请把下面的错误编号发给客服。
            </p>
            <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={reset}
                style={{ background: 'linear-gradient(135deg, #7d50e0, #906be4)', color: '#fff', border: 0, borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
              >
                重试
              </button>
              {/* 刻意用 <a> 而不是 next/link：global-error 渲染时根 layout 与 Router 上下文
                  可能已经崩掉，用 <Link> 等于在「最需要它能显示」的时刻多挂一个可能抛错的依赖。
                  代价是这一跳整页刷新 —— 对兜底页来说可接受，也更稳。 */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- 兜底页不依赖 Router，见上 */}
              <a
                href="/"
                style={{ border: '1px solid #ebe4f8', borderRadius: 8, padding: '9px 16px', fontSize: 14, color: '#8c8c8c', textDecoration: 'none' }}
              >
                回首页
              </a>
            </div>
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed #ebe4f8' }}>
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                style={{ background: 'none', border: 0, padding: 0, fontSize: 12, color: '#8c8c8c', cursor: 'pointer', textDecoration: 'underline' }}
              >
                {showDetail ? '收起错误详情' : '查看错误详情'}
              </button>
              {showDetail && (
                <pre style={{ marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, lineHeight: 1.6, color: '#8c8c8c' }}>
                  {`信息：${error?.message || '（生产构建下不暴露错误文本，请凭编号排查）'}\n编号：${error?.digest || '-'}`}
                </pre>
              )}
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
