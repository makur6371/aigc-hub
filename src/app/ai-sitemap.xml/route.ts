// ai-sitemap.xml：给 AI 爬虫的 sitemap，比 sitemap.xml 多列 llms.txt 等机器可读入口。
//
// 原先是一份手写的 public/ai-sitemap.xml，与 sitemap.ts 各维护一份路由清单 ——
// 两份必然漂移（/mcp 就漏在这份里）。现在两处都从 src/lib/public-routes.ts 生成。

import { AI_SITEMAP_EXTRAS, BASE_URL, LAST_MODIFIED, PUBLIC_ROUTES } from '@/lib/public-routes'

// 内容是确定的，构建期静态生成，避免每次请求重算
export const dynamic = 'force-static'

const DATE = LAST_MODIFIED.toISOString().slice(0, 10)

function entry(path: string, priority: number, changeFrequency: string): string {
  return [
    '  <url>',
    `    <loc>${BASE_URL}${path}</loc>`,
    `    <lastmod>${DATE}</lastmod>`,
    `    <changefreq>${changeFrequency}</changefreq>`,
    `    <priority>${priority.toFixed(1)}</priority>`,
    '  </url>',
  ].join('\n')
}

export function GET(): Response {
  const urls = [
    ...PUBLIC_ROUTES.filter((r) => r.indexed).map((r) => entry(r.path, r.priority, r.changeFrequency)),
    ...AI_SITEMAP_EXTRAS.map((p) => entry(p, 0.5, 'weekly')),
  ]

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
