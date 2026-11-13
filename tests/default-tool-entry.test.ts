import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_IMAGE_TOOL_SLUG } from '@/lib/constants/categories'

/**
 * 工具箱 / 首页的默认落点守卫（防回归）
 *
 * 背景（真实问题）：工具箱「无记录时进哪个工具」原本是
 * `orderBy: { createdAt: 'desc' }` 取第一条 —— 结果随每次上新漂移。
 * 上架「俄区智能套图」后，新用户点「工具箱」直接进了一个垂直领域的复杂工具。
 *
 * 默认落点是**产品决策**，不该由数据插入顺序决定，所以固定成常量。
 * 这条守卫锁住「默认值必须显式声明、且不能退回到按时间取第一条」。
 */

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('默认落点守卫', () => {
  it('工具箱入口展示目录，不再重定向到单一工具', () => {
    const page = read('app/(app)/tools/page.tsx')
    expect(page).toContain("status: 'APPROVED'")
    expect(page).toContain('notIn: CREATE_TOOL_SLUGS')
    // 目录必须直接把工具链接给用户；服务端 redirect 会多一次跳转且容易落错工具
    expect(page).not.toContain('redirect(')
    expect(page).toContain('/tools/${tool.slug}')
  })

  it('上次使用只作为「继续使用」入口，且必须存在于可用工具列表', () => {
    const page = read('app/(app)/tools/page.tsx')
    expect(page).toContain('lastToolSlug')
    expect(page).toMatch(/tools\.find\(\(tool\) => tool\.slug === lastSlug\)/)
  })

  it('工具箱目录不展示创作区工具，且创作区工具不写工具箱记忆', () => {
    const page = read('app/(app)/tools/page.tsx')
    const studio = read('components/tools/ToolStudio.tsx')
    expect(page).toMatch(/notIn: CREATE_TOOL_SLUGS/)
    expect(studio).toMatch(/CREATE_TOOL_SLUGS\.includes\(toolSlug\)/)
  })

  it('首页创作入口仍与图像工具常量解耦', () => {
    const home = read('app/page.tsx')
    expect(read('lib/constants/categories.ts')).toContain('DEFAULT_IMAGE_TOOL_SLUG')
    expect(home).not.toMatch(/^const DEFAULT_IMAGE_TOOL_SLUG =/m)
  })

  it('工具页不再有「工具/智能体」页内切换器（身份不互相寄生）', () => {
    const studio = read('components/tools/ToolStudio.tsx')
    expect(studio).not.toContain('switchPanelMode')
    // 经典工具页仍有「切到 Agent」出口（创作区则是统一菜单切换）
    expect(studio).toContain("onCreateModeChange('agent')")
  })

  it('导航顺序：创作排第二，Agent 收入创作区', () => {
    const nav = read('components/layout/NavRail.tsx')
    // 不锚定换行：源文件是 CRLF，靠 \n 会匹配不上
    const items = /const NAV_ITEMS = \[([^\]]*)\]/.exec(nav)
    expect(items, '找不到 NAV_ITEMS').not.toBeNull()
    const hrefs = [...items![1].matchAll(/href: '([^']+)'/g)].map((m) => m[1])
    expect(hrefs[0]).toBe('/')
    expect(hrefs[1]).toBe('/create')
    expect(hrefs).not.toContain('/agent')
  })
})
