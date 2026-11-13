// ===== 公开页 GEO 清单：单一真相源 =====
//
// 为什么集中到这里：这份清单原先散在 4 处手写 ——
//   1. src/app/sitemap.ts 的数组
//   2. public/ai-sitemap.xml 的静态 XML
//   3. nginx.conf 的 `location = /xxx` 分支（AI 爬虫改走预渲染页）
//   4. Dockerfile CMD 里的 `for f in product pricing faq about` 拷贝列表
// 新增一个公开页要改四处，漏一处就是**静默失效** —— `/mcp` 就是这么漏的
// （2026-10-26 实测：页面健康、被 llms.txt 引用，却不在 sitemap 与预渲染里）。
//
// 现在 1、2 由本文件生成；3、4 是 nginx / shell 语法没法 import，
// 改由 tests/geo-surface-coverage.test.ts 守住一致性 —— 漏了 CI 直接红。

export type ChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never'

export type PublicRoute = {
  /** 站内路径。同时用于 sitemap 的 loc 与 nginx 的 `location =` */
  path: string
  /**
   * 预渲染后的文件名（容器内 `/prerender/<name>`）。
   * null = 动态 SSR，不进 /prerender（例如 ISR 的 /gallery）。
   */
  prerenderAs: string | null
  /** 是否进 sitemap.xml / ai-sitemap.xml */
  indexed: boolean
  priority: number
  changeFrequency: ChangeFrequency
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  // 首页特殊：构建产物是 index.html，Dockerfile 里单独拷成 home.html
  { path: '/', prerenderAs: 'home.html', indexed: true, priority: 1, changeFrequency: 'weekly' },
  { path: '/faq', prerenderAs: 'faq.html', indexed: true, priority: 0.8, changeFrequency: 'monthly' },
  // 平台使用规范：内容稳定、需要能被搜索引擎与用户直接访问；不做 nginx 预渲染特例
  // 作品广场是 ISR 动态渲染（revalidate=3600），刻意不做静态预渲染
  { path: '/gallery', prerenderAs: null, indexed: true, priority: 0.7, changeFrequency: 'weekly' },
]

/**
 * 公开但**刻意不索引**的页面（页面自己设了 robots noindex）。
 * 必须显式登记，否则守卫测试会认为「新增页面忘了进 GEO 清单」。
 */
export const NOINDEX_ROUTES = ['/model-pricing']

/** 进 ai-sitemap.xml 的机器可读入口（不是 page.tsx，所以单列）。 */
export const AI_SITEMAP_EXTRAS: string[] = []

export const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

// 用固定锚点日期而非 Date.now()：构建产物保持稳定，避免无意义的 lastmod 抖动。
// 内容有实质变化时手工前移这个日期。
export const LAST_MODIFIED = new Date('2026-10-26')
