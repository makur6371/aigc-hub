import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { GUIDE_STEPS } from '@/components/ui/FirstUseGuide'

/**
 * 引导锚点守卫（防回归）
 *
 * 背景：FirstUseGuide 靠 CSS 选择器把高亮框套到真实控件上（step.anchor）。
 * 锚点写错了**不会有任何报错**，只会静默退化成居中弹卡 ——
 * 用户看到的是「这一步没指到任何地方」，体验反而更差，而开发者完全不知道。
 *
 * 真实发生过：画布引导的 `#copilot-input` 在 CopilotPanel 里根本不存在，
 * 3 步里有 1 步锚点失效、另 2 步压根没写锚点，却一直没人发现。
 *
 * 这条守卫把「锚点必须真实存在」从「靠人记住」变成「CI 拦住」。
 */

const SRC = join(__dirname, '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

const SOURCES = walk(SRC).map((f) => readFileSync(f, 'utf8'))

/** 锚点选择器是否在源码里真实存在（data-guide="x" 或 id="x"） */
function anchorExists(selector: string): boolean {
  // 只支持本项目在用的两种形态：#id / [data-guide="x"]
  const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(selector)
  const attrMatch = /^\[data-guide="([A-Za-z0-9_-]+)"\]$/.exec(selector)
  if (idMatch) {
    return SOURCES.some((s) => s.includes(`id="${idMatch[1]}"`))
  }
  if (attrMatch) {
    return SOURCES.some((s) => s.includes(`data-guide="${attrMatch[1]}"`))
  }
  // 其它形态（复杂选择器）不在此守卫范围，但要求显式声明，避免写法悄悄漂移
  throw new Error(`引导锚点写法不在守卫支持范围（只支持 #id 与 [data-guide="x"]）：${selector}`)
}

describe('引导锚点守卫', () => {
  const scenarios = Object.entries(GUIDE_STEPS) as Array<[string, readonly { title: string; anchor?: string; hint?: string }[]]>

  for (const [key, steps] of scenarios) {
    it(`[${key}] 每一步都指向真实存在的控件`, () => {
      const missing: string[] = []
      for (const [i, step] of steps.entries()) {
        const sel = step.anchor || step.hint
        if (!sel) {
          missing.push(`第 ${i + 1} 步「${step.title}」没有 anchor —— 会退化成居中弹卡，指不到任何控件`)
          continue
        }
        if (!anchorExists(sel)) {
          missing.push(`第 ${i + 1} 步「${step.title}」锚点 ${sel} 在源码里找不到`)
        }
      }
      expect(missing, `以下引导步骤锚点无效：\n  ${missing.join('\n  ')}`).toEqual([])
    })
  }

  it('页面内的「已看过」precheck 不硬编码版本号（必须与 FirstUseGuide 同源）', () => {
    // 真实踩过：ToolStudio 里手写 `guide:seen:tools:v5`，
    // 一旦 GUIDE_VERSIONS 调整，precheck 与组件的 key 就会失配 ——
    // 表现为「引导重新弹了，但移动端 Tab 没提前切到面板」这类难查的小 bug。
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8')
      if (!src.includes('guide:seen:')) continue
      if (f.endsWith(join('ui', 'FirstUseGuide.tsx'))) continue
      // 允许 guide:seen:${...}:v${guideVersionOf(...)}
      const hardcoded = /guide:seen:[^\n]*:v\d/.test(src)
      if (hardcoded) offenders.push(f.replace(SRC, 'src'))
    }
    expect(offenders, `以下文件硬编码了引导版本号，请改用 guideVersionOf()：\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('锚点若位于「默认收起」的容器内，该步必须声明 onEnter 把它展开', () => {
    // 真实踩过：Copilot 默认收起成胶囊，输入框/模型下拉都不在 DOM 里，
    // 引导前两步的锚点必然落空、静默退化成居中弹卡 —— 而「锚点存在于源码」这条守卫
    // 是**看不出来**的（元素确实在源码里，只是没挂载）。
    //
    // 所以这里补一层条件检查：只要某步的锚点位于「条件渲染」的分支里，
    // 就必须给出 onEnter（或显式标注不需要）。
    const CONDITIONAL = [
      // Copilot 面板：open === false 时只渲染胶囊，其余都在 open 分支内
      { anchor: '#copilot-input', needOpen: 'GUIDE_OPEN_COPILOT_EVENT' },
      { anchor: '#copilot-brain', needOpen: 'GUIDE_OPEN_COPILOT_EVENT' },
    ]
    const offenders: string[] = []
    for (const [key, steps] of Object.entries(GUIDE_STEPS)) {
      for (const [i, step] of (steps as readonly { title: string; anchor?: string; onEnter?: () => void }[]).entries()) {
        const sel = step.anchor || ''
        const cond = CONDITIONAL.find((c) => c.anchor === sel)
        if (cond && !step.onEnter) {
          offenders.push(`[${key}] 第 ${i + 1} 步「${step.title}」锚点 ${sel} 在默认收起的容器里，但没有 onEnter 展开它`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('每个场景至少有 3 步（避免引导退化成一句废话）', () => {
    for (const [key, steps] of scenarios) {
      expect(steps.length, `[${key}] 步骤过少`).toBeGreaterThanOrEqual(3)
    }
  })
})
