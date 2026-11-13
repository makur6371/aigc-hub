import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 助手文本必须走 Markdown 渲染（防回归）
 *
 * 用户实测（2026-10-01）：Agent 回复里的 GFM 表格被 `whitespace-pre-wrap`
 * 原样打出来 —— 满屏 `| 图片 | 方向 | 卖点文案 |` 和 `|---|---|`，
 * 完全没渲染。根因不是缺依赖，而是 Agent 面板**根本没接 markdown**。
 *
 * 另外发现：Canvas Copilot 与公告弹窗虽然用了 react-markdown，
 * 但都没挂 `remark-gfm` → **表格（GFM 扩展）同样渲染不出来**。
 * 而 Agent 回复里表格是高频内容（方案对照、参数清单）。
 *
 * 所以收敛到一个共享组件，并钉住三件事：
 *   1) 共享组件存在且挂了 remark-gfm
 *   2) 三个展示位都必须用它（不能再各写一份、也不能退回纯文本）
 *   3) 不引入 rehype-raw（那会打开 HTML 执行通道 = XSS 面）
 */

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('Markdown 渲染收敛', () => {
  const md = read('components/ui/Markdown.tsx')

  it('共享组件挂了 remark-gfm（否则表格渲染不出来）', () => {
    expect(md).toContain('remarkGfm')
    expect(md).toMatch(/remarkPlugins=\{\[remarkGfm\]\}/)
  })

  it('共享组件不引入 rehype-raw（避免打开 HTML 执行通道）', () => {
    // 只看代码，不看注释 —— 注释里为了解释「为什么不引」会提到它
    const code = md
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/^\s*\/\/.*$/gm, '')        // 行注释
    expect(code).not.toContain('rehype-raw')
    expect(code).not.toContain('rehypeRaw')
    expect(code).not.toContain('dangerouslySetInnerHTML')
    // 并且确实没有把它挂进 rehypePlugins
    expect(code).not.toMatch(/rehypePlugins/)
  })

  it('样式里含表格规则（th/td/table），保证表格可读', () => {
    expect(md).toContain('[&_table]')
    expect(md).toContain('[&_th]')
    expect(md).toContain('[&_td]')
  })

  it('Agent 面板用 Markdown 渲染，不再纯文本直出', () => {
    const panel = read('components/tools/ToolAgentPanel.tsx')
    expect(panel).toContain("from '@/components/ui/Markdown'")
    expect(panel).toContain('<Markdown>{text}</Markdown>')
    // 关键：不能退回 whitespace-pre-wrap 直出正文
    expect(panel).not.toMatch(/whitespace-pre-wrap">\{text\}/)
  })

  it('Copilot 面板用共享组件，且本地那份实现已删除', () => {
    const cp = read('components/canvas/CopilotPanel.tsx')
    expect(cp).toContain("from '@/components/ui/Markdown'")
    expect(cp).not.toContain('function AssistantMarkdown')
    expect(cp).not.toContain("from 'react-markdown'")
  })

  it('公告弹窗用共享组件', () => {
    const bell = read('components/layout/AnnouncementBell.tsx')
    expect(bell).toContain("from '@/components/ui/Markdown'")
    expect(bell).not.toContain("from 'react-markdown'")
  })

  it('全库只有 Markdown.tsx 直接依赖 react-markdown（单一出口）', () => {
    const files = [
      'components/ui/Markdown.tsx',
      'components/canvas/CopilotPanel.tsx',
      'components/layout/AnnouncementBell.tsx',
      'components/tools/ToolAgentPanel.tsx',
    ]
    const direct = files.filter((f) => read(f).includes("from 'react-markdown'"))
    expect(direct).toEqual(['components/ui/Markdown.tsx'])
  })
})
