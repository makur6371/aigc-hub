import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ErrorFallback, scopeFromPathname } from '@/components/ui/ErrorFallback'
import { readSource } from './helpers/source-guard'

/**
 * 错误边界（Q-D44）。
 *
 * 这台机器上没有可用的浏览器运行时，所以走**真实渲染**验证而不是肉眼：
 * `renderToStaticMarkup` 会把兜底组件整个渲染成 HTML —— 它崩了、渲染不出文字、
 * 或者依赖缺失，这里就会红。这比「编译过了」强，因为编译看不出兜底自己是不是空的。
 *
 * 另外钉一组**结构守卫**：本项目的错误边界缺失了好几个月，没有任何工具会报
 * 「少了一个 error.tsx」，只有显式断言存在性才能防止它再被删掉。
 */

const err = Object.assign(new Error('画布节点渲染失败'), { digest: 'abc123' })

/**
 * 负向断言前必须去注释：本文件第一次跑就红在「global-error 不许引用 ErrorFallback」上 ——
 * 而它其实没引用，只是**头注释里解释了自己为什么不引用**。
 * 带着注释做负向断言，等于让「解释规则的文档」触发「违反规则的失败」。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n')
}

describe('ErrorFallback 真能渲染出内容', () => {
  it('渲染出位置名、安抚语与两个出口', () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { error: err, scope: '画布' }))
    expect(html).toContain('画布暂时打不开')
    // 用户此刻唯一的问题是「我刚才生成的东西是不是没了」—— 这句必须在
    expect(html).toContain('已生成的成果都还在服务器上')
    expect(html).toContain('回首页')
    expect(html).toContain('查看错误详情')
  })

  it('给了 reset 才出现「重试」：没有它时不渲染一个点了没反应的按钮', () => {
    expect(renderToStaticMarkup(createElement(ErrorFallback, { error: err, reset: () => {} }))).toContain('重试')
    expect(renderToStaticMarkup(createElement(ErrorFallback, { error: err }))).not.toContain('>重试<')
  })

  it('错误详情带上信息、编号与地址；生产环境没有 message 时给替代话术', () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { error: err, scope: '工具箱' }))
    expect(html).toContain('画布节点渲染失败')
    expect(html).toContain('abc123')
    const bare = renderToStaticMarkup(createElement(ErrorFallback, { error: {} as never }))
    expect(bare).toContain('生产构建下浏览器侧不暴露错误文本')
  })

  it('自定义 homeHref：后台的兜底不该把管理员丢到前台首页', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorFallback, { error: err, scope: '管理后台', homeHref: '/admin/ops', homeLabel: '回运维面板' }),
    )
    expect(html).toContain('href="/admin/ops"')
    expect(html).toContain('回运维面板')
  })
})

describe('scopeFromPathname —— 崩的是哪一块', () => {
  it('按首段映射真实功能区', () => {
    expect(scopeFromPathname('/canvas')).toBe('画布')
    expect(scopeFromPathname('/tools/ecom-main-image')).toBe('工具箱')
    expect(scopeFromPathname('/user/profile')).toBe('个人中心')
  })

  it('未知或空路径返回 undefined，不抛错也不显示怪标题', () => {
    expect(scopeFromPathname('/some-new-place')).toBeUndefined()
    expect(scopeFromPathname(null)).toBeUndefined()
    expect(scopeFromPathname('')).toBeUndefined()
  })
})

describe('边界文件必须存在（结构守卫）', () => {
  const boundaries = [
    'src/app/error.tsx',
    'src/app/(app)/error.tsx',
    'src/app/(public)/error.tsx',
    'src/app/admin/error.tsx',
    'src/app/not-found.tsx',
    'src/app/global-error.tsx',
  ]

  it('六个段各自有兜底，缺一个就会退化成 Next 默认错误页', () => {
    for (const f of boundaries) expect(readSource(f).length).toBeGreaterThan(0)
  })

  it('error.tsx 必须是客户端组件，且复用同一份 ErrorFallback', () => {
    for (const f of ['src/app/error.tsx', 'src/app/(app)/error.tsx', 'src/app/(public)/error.tsx', 'src/app/admin/error.tsx']) {
      const src = readSource(f)
      expect(src.startsWith("'use client'")).toBe(true)
      expect(src).toContain('ErrorFallback')
    }
  })

  it('global-error 自带 html/body 且不依赖站内样式 —— 它是根 layout 崩掉时唯一的出口', () => {
    const src = readSource('src/app/global-error.tsx')
    const code = codeOnly(src)
    expect(code).toContain('<html')
    expect(code).toContain('<body')
    expect(src.startsWith("'use client'")).toBe(true)
    // 不能引用 ErrorFallback / 站内 class / 任何 CSS：根 layout 失效时这些都不可用
    expect(code).not.toContain('ErrorFallback')
    expect(code).not.toContain('className=')
    // 也不许 import 站内组件：只允许 react / next 自身
    expect(code).not.toMatch(/^import .*from '@\/(components|lib)/m)
  })

  it('404 页不得被搜索引擎收录', () => {
    expect(readSource('src/app/not-found.tsx')).toContain('index: false')
  })
})
