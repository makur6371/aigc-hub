import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

describe('工具成果「已生成 · 链接已过期」态（Q-703 行为口径）', () => {
  const studio = readSource('src/components/tools/ToolStudio.tsx')

  it('图片加载失败只标记 imageState，不改 status（生成成功与显示失败必须分离）', () => {
    expect(studio).toMatch(/x\.url === item\.url && x\.status === 'done' \? \{ \.\.\.x, imageState: 'expired' as const \}/)
    expect(studio).not.toMatch(/status: 'error'[\s\S]{0,80}imageState/)
  })

  it('加载成功回 ok 并清掉重试痕迹（不写无意义的全量 setState）', () => {
    expect(studio).toMatch(/imageState: 'ok' as const, retryCount: 0/)
  })

  it('手动重试换 cache-busting 参数（retryCount 自增）', () => {
    expect(studio).toMatch(/retryCount: \(x\.retryCount \?\? 0\) \+ 1/)
  })

  const slot = readSource('src/app/(app)/tools/[slug]/slot-controls.tsx')

  it('过期态渲染品牌占位（降透明去饱和）+ 明确文案 + 重试按钮', () => {
    expect(slot).toMatch(/AnimatedLogo size=\{26\} className="opacity-25 grayscale"/)
    expect(slot).toContain('已生成 · 链接已过期')
    expect(slot).toMatch(/onRetry\(\)/)
  })
})
