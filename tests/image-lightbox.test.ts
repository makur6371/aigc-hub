import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('图片放大能力（防回归）', () => {
  it('存在可复用灯箱组件', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toContain('export function ImageLightbox')
  })

  it('灯箱支持受控开关与 URL 数组（便于 PreviewGroup 式浏览）', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toMatch(/open|onClose/)
    expect(lb).toMatch(/urls|images/)
  })

  it('Markdown 里的图片可点击放大', () => {
    const md = read('components/ui/Markdown.tsx')
    expect(md).toContain('ImageLightbox')
    expect(md).toMatch(/onClick/)
  })

  it('灯箱有 zoom 控制（用户诉求：不靠浏览器默认行为）', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toMatch(/zoom|放大|缩小|scale/)
  })

  it('三处展示位都接上了灯箱（Markdown / Agent 上传图 / 成果区）', () => {
    expect(read('components/ui/Markdown.tsx')).toContain('ImageLightbox')
    expect(read('components/tools/ToolAgentPanel.tsx')).toContain('ImageLightbox')
    // 成果区的那处在共享骨架里。
    // 注：2026-10-02 起 /tools/[slug] 与 /agent 都是薄壳，三段式实现在 ToolStudio ——
    // 断言实现文件而不是路由文件，路由再怎么拆都不会让这条守卫失效。
    expect(read('components/tools/ToolStudio.tsx')).toContain('ImageLightbox')
  })

  it('成果区放大不与「送到工作台」抢点击（走独立 onZoom 回调）', () => {
    const sc = read('app/(app)/tools/[slug]/slot-controls.tsx')
    expect(sc).toContain('onZoom?')
    // 放大按钮必须 stopPropagation，否则点它会连带触发卡片的 onClick
    expect(sc).toMatch(/onZoom\(\)[\s\S]{0,40}stopPropagation|stopPropagation\(\)[\s\S]{0,40}onZoom/)
    // 缩略图 hover 才出现 + 触屏常显
    expect(sc).toContain('group-hover:opacity-100')
    expect(sc).toContain('max-lg:opacity-100')
  })

  it('hover 出「查看」按钮（用户诉求原话）', () => {
    expect(read('components/ui/Markdown.tsx')).toContain('查看')
    expect(read('components/tools/ToolAgentPanel.tsx')).toContain('查看')
  })

  it('灯箱处理链接过期（破图不能只留白）', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toContain('onError')
    expect(lb).toMatch(/过期|失效/)
  })

  it('灯箱支持键盘操作（Esc / 左右 / 加减）', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toContain('Escape')
    expect(lb).toContain('ArrowLeft')
    expect(lb).toContain('ArrowRight')
  })

  it('灯箱使用大画布并提供明确关闭按钮', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toContain('width="min(1500px, 96vw)"')
    expect(lb).toContain('height: \'min(84dvh, 900px)\'')
    expect(lb).toContain('aria-label="关闭预览"')
    expect(lb).toContain('closable={false}')
  })

  it('移动端支持双指缩放、单指拖动与左右滑动', () => {
    const lb = read('components/ui/ImageLightbox.tsx')
    expect(lb).toContain('onPointerDown')
    expect(lb).toContain('pointerDistance')
    expect(lb).toContain('双指缩放 · 单指拖动 · 左右滑动切换')
    expect(lb).toContain('touch-none')
  })

  it('运营面板产物图片复用统一灯箱，不再手写大图遮罩', () => {
    const ops = read('components/admin/OpsDashboard.tsx')
    expect(ops).toContain('ImageLightbox')
    expect(ops).toContain("previewMedia?.kind === 'image'")
    expect(ops).not.toContain('fixed inset-0 z-[1100]')
  })

  it('成果列表、灯箱和编辑器复用原图代理', () => {
    expect(read('app/(app)/tools/[slug]/slot-controls.tsx')).toContain('toAssetProxyUrl')
    expect(read('components/tools/ToolStudio.tsx')).toContain('toAssetProxyUrl')
    expect(read('components/tools/Workbench.tsx')).toContain('<ImageEditor')
    expect(read('components/tools/ImageEditor.tsx')).toContain('toProxyUrl(url)')
  })

})
