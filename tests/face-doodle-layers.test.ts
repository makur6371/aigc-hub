import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readNodeBodiesSource } from './helpers/canvas-node-bodies'

/**
 * 人脸涂鸦节点三层结构 + 工作台交互守卫
 *
 * 背景（2026-10-16）：用户报「人脸智能涂鸦做得非常不好用」，实测发现两类问题：
 *
 * ① 节点只有「一个全屏 Modal 装 7 个参数」，与站内「图像生成」节点的
 *    「上参数条 + 中卡身 + 下填写面板」三层范式完全不一致。
 *    现已对齐：参数条调高频参数、下方面板看得见框状态、卡身铺满结果图。
 *
 * ② 工作台三个交互缺陷（都是「用户以为坏了」级别）：
 *    - 「重新扫描」setBoxes(merged) 静默清掉用户手动补的框
 *    - 灵敏度/切片/补框改了不触发重扫，用户想不到要点「重新扫描」
 *    - 没有清空全部 / 恢复默认，参数调乱后回不去
 */

const SRC = join(__dirname, '..', 'src')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n')

// Q-303：node-bodies 已拆成目录。本测试的区间断言跨文件
// （FaceDoodleBody 在 bodies.tsx、FaceDoodleParamBar 在 param-bars.tsx），
// 所以按固定顺序拼起来读，区间语义与拆分前一致。
const bodies = readNodeBodiesSource()
const workbench = read('components/canvas/FaceDoodleWorkbench.tsx')
const catalog = read('components/canvas/CatalogPanel.tsx')
const page = read('app/(app)/canvas/page.tsx')

const sliceBetween = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  return a < 0 ? '' : src.slice(a, b < 0 ? src.length : b)
}

describe('涂鸦节点三层结构（对齐图像生成范式）', () => {
  it('paramBar 与 promptPanel 都有 face-doodle 分派', () => {
    expect(bodies).toMatch(/case 'face-doodle': return <FaceDoodleParamBar \{\.\.\.ctx\} \/>/)
    expect(bodies).toMatch(/case 'face-doodle': return <FaceDoodlePanel \{\.\.\.ctx\} \/>/)
  })

  it('参数条含四个高频参数 + 工作台入口 + 运行按钮', () => {
    const bar = sliceBetween(bodies, 'export function FaceDoodleParamBar', 'export function FaceDoodlePanel')
    for (const k of ['density', 'strokeWidth', 'coverage', 'threshold']) {
      expect(bar, `参数条缺 ${k}`).toContain(`'${k}'`)
    }
    expect(bar).toContain('ctx.onOpenWorkbench?.(ctx.node.id)')
    expect(bar).toContain('<RunButton ctx={ctx} />')
  })

  it('下方面板看得见框状态（来源 + 尺寸），并能清空', () => {
    const panel = sliceBetween(bodies, 'export function FaceDoodlePanel', 'export function dispatchParamBar')
    expect(panel).toContain("f.isFallback ? '兜底'")
    expect(panel).toContain("f.isManual ? '手动'")
    expect(panel).toContain('Math.round(f.w ?? 0)')
    expect(panel).toContain("ctx.onUpdateInput(ctx.node.id, 'faces', [])")
  })

  it('卡身铺满结果图（与 ImageGenerateBody 同形），不再只放一个小按钮', () => {
    const bd = sliceBetween(bodies, 'export function FaceDoodleBody', 'export function FaceDoodleParamBar')
    expect(bd).toContain('<MediaActions')
    expect(bd).toContain('className="w-full bg-surface"')
    expect(bd).not.toContain('打开涂鸦工作台')
  })
})

describe('工作台：重扫不得清掉用户手动框', () => {
  it('runDetect 支持 preserveManual，且默认合并而非覆盖', () => {
    expect(workbench).toMatch(/const runDetect = async \(w: number, h: number, preserveManual = false\)/)
    expect(workbench).toContain('setBoxes((prev) => {')
    expect(workbench).toContain('prev.filter((b) => b.isManual || b.isFallback)')
  })

  it('「重新扫描」按钮走 preserveManual=true', () => {
    expect(workbench).toMatch(/onClick=\{\(\) => void runDetect\(imgSize\.w, imgSize\.h, true\)\}/)
  })

  it('setBoxes(merged) 只在首次检测（preserveManual=false）分支出现', () => {
    // 首次自动检测覆盖是对的（本来就没框）；preserveManual 时必须走合并分支。
    const branch = sliceBetween(workbench, 'if (preserveManual) {', '} else {')
    expect(branch).toContain('setBoxes((prev) => {')
    expect(branch).not.toContain('setBoxes(merged)')
    // 覆盖写法只能出现在 else 分支里
    expect(workbench).toMatch(/} else \{\s*setBoxes\(merged\)\s*\}/)
  })
})

describe('工作台：检测参数改动即时重扫 + 可回到默认', () => {
  it('灵敏度/切片/补框改动后自动重扫（且保留手动框），至少 3 处', () => {
    const hits = workbench.match(/runDetect\(imgSize\.w, imgSize\.h, true\)/g) || []
    // 重新扫描按钮 + 切片 + 补框 + 灵敏度 = 4 处
    expect(hits.length).toBeGreaterThanOrEqual(4)
  })

  it('提供「清空框」与「恢复默认」', () => {
    expect(workbench).toContain('清空框')
    expect(workbench).toContain('恢复默认')
    expect(workbench).toContain('DOODLE_DEFAULTS.density')
    expect(workbench).toContain('DOODLE_DEFAULTS.threshold')
  })

  it('底部提示写明「重新扫描会保留手动框」（消除不确定感）', () => {
    expect(workbench).toContain('重新扫描会保留手动框')
  })
})

describe('节点库面板：详情面板不得压住分类面板', () => {
  it('详情面板 left 不再向左偏移覆盖分类面板', () => {
    expect(catalog).toMatch(/const detailLeft = clampX\(catLeft \+ CAT_W \+ 2, DETAIL_W\)/)
    expect(catalog).not.toMatch(/clampX\(catLeft \+ CAT_W - 4/)
  })

  it('详情面板 z-index 高于分类面板', () => {
    expect(catalog).toMatch(/top: detailTop, width: DETAIL_W, zIndex: 61/)
  })

  it('页面层不再持有只写不读的 catalogHoverCat 死状态', () => {
    expect(page).not.toContain('catalogHoverCat')
    expect(page).not.toContain('catalogCatsFor')
  })
  it('工作台参数实时回写节点（onParamsChange 链路完整）', () => {
    expect(workbench).toContain('onParamsChange?: (patch: Partial<FaceDoodleParams>) => void')
    expect(page).toContain('updateNodeInput(doodleNode.id, k, v)')
  })
  it('七个参数都有带回写的 setter', () => {
    const setters = ['setDensityP', 'setStrokeWidthP', 'setSpikeP', 'setCoverageP', 'setMultiViewP', 'setThresholdP', 'setAutoFallbackP']
    for (const s of setters) expect(workbench, `缺 ${s}`).toContain(`const ${s} = useCallback`)
  })
  it('UI 控件走带回写的 setter，不用裸 setter 绕过同步', () => {
    expect(workbench).toContain('onChange={(v) => setDensityP(v)}')
    expect(workbench).toContain('onChange={(v) => setStrokeWidthP(v)}')
    expect(workbench).toContain('onChange={(v) => setSpikeP(v as number)}')
    expect(workbench).toContain('onChange={(v) => setCoverageP(v as number)}')
    expect(workbench).toContain('setThresholdP(v as number)')
    expect(workbench).toContain('setMultiViewP(v)')
    expect(workbench).toContain('setAutoFallbackP(v)')
    // 裸 setter 只允许出现在 P 包装器内部与「打开时从 props 重置」
    const bare = workbench.match(/set(Density|StrokeWidth|Spike|Coverage|MultiView|Threshold|AutoFallback)\(/g) || []
    // 7 个 P 包装器内部 + 7 个打开时重置 = 14
    expect(bare.length).toBeLessThanOrEqual(14)
  })
  it('每次打开工作台从节点参数重置（否则看到上一套旧值）', () => {
    const openBlock = sliceBetween(workbench, 'if (!(open && !prevOpen.current)) return', 'setPhaseMsg')
    expect(openBlock).toContain('if (initialParams) {')
    expect(openBlock).toContain('setDensity(initialParams.density)')
    expect(openBlock).toContain('setStrokeWidth(initialParams.strokeWidth)')
    expect(openBlock).toContain('setThreshold(initialParams.threshold)')
    expect(openBlock).toContain('setAutoFallback(initialParams.autoFallback)')
  })
})
