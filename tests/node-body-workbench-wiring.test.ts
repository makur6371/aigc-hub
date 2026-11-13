import { describe, it, expect } from 'vitest'
import { readNodeBodiesSource } from './helpers/canvas-node-bodies'
import { readSource } from './helpers/source-guard'

/**
 * 卡身「打开工作台」按钮接线守卫
 *
 * 事故形状（2026-10-16 实测）：人脸智能涂鸦节点上线后，
 * 卡身上的「打开涂鸦工作台」按钮**点了完全没反应，且控制台零报错**。
 *
 * 根因：`dispatchNodeBody(type, ctx, extra)` 的 extra 里带 `onOpenWorkbench`
 * （页面层注入的回调），但 `case 'face-doodle'` / `case 'image-crop'`
 * 直接 `return XxxBody(ctx)`，**没有把 extra.onOpenWorkbench 并进 ctx**。
 * 于是 `ctx.onOpenWorkbench?.(ctx.node.id)` 是 `undefined?.()` ——
 * 可选链调用，静默跳过，不抛错、不告警。
 *
 * 为什么必须钉死：
 *   1) 这是静默失效 —— 没有报错、没有告警，用户只觉得「按钮坏了」
 *   2) 可选链 `?.` 正是让它静默的原因，重构时极易被"优化"回去
 *   3) 同类形状：任何走 extra 注入的回调，漏并 ctx 都会静默失效
 *      （image-upload 的 onUploadFiles 就是正确范例，它并了）
 */

// Q-D42 之后 node-bodies 已拆成目录；守卫要扫整个目录而不是单个 barrel
const nodeBodies = readNodeBodiesSource()
// Q-D25/Q-D801：CanvasNodeCard 已从 canvas/page.tsx 抽成独立模块。
// `bodyCtx` / `customBody`（也就是 dispatchNodeBody 的调用点）本来就在这个组件**内部**，
// 所以拆完之后它们跟着组件走了 —— 守卫必须跟着改，否则断言会指向一个已经不在那里的文件。
const nodeCard = readSource('src/components/canvas/CanvasNodeCard.tsx')

describe('dispatchNodeBody —— extra 回调必须并进 ctx', () => {
  it('face-doodle 与 image-crop 都并入 onOpenWorkbench', () => {
    expect(nodeBodies).toContain('case \'image-crop\': return <ImageCropBody {...ctx} onOpenWorkbench={extra.onOpenWorkbench} />')
    expect(nodeBodies).toContain('case \'face-doodle\': return <FaceDoodleBody {...ctx} onOpenWorkbench={extra.onOpenWorkbench} />')
  })

  it('两个卡身都从 ctx 读 onOpenWorkbench（而不是自己另找入口）', () => {
    // 工作台按钮只能有一个触发源，否则会出现"有的入口能用有的不能用"
    expect(nodeBodies).toMatch(/onClick=\{\(\) => ctx\.onOpenWorkbench\?\.\(ctx\.node\.id\)\}/)
    // face-doodle 与 image-crop 各出现一次
    const hits = nodeBodies.match(/ctx\.onOpenWorkbench\?\.\(ctx\.node\.id\)/g) || []
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it('image-upload 的 onUploadFiles 仍是正确范例（不得回归）', () => {
    expect(nodeBodies).toContain('case \'image-upload\': case \'image-upload-batch\': return <ImageUploadBody {...ctx} onUploadFiles={extra.onUploadFiles} />')
  })
})

describe('页面层注入契约', () => {
  it('bodyCtx 不含 onOpenWorkbench，它只走 extra（否则会出现两份真相源）', () => {
    const bodyCtxBlock = nodeCard.slice(
      nodeCard.indexOf('const bodyCtx'),
      nodeCard.indexOf('const customBody'),
    )
    expect(bodyCtxBlock).not.toContain('onOpenWorkbench')
  })

  it('dispatchNodeBody 调用点确实把 onOpenWorkbench 传进 extra', () => {
    expect(nodeCard).toMatch(/dispatchNodeBody\(node\.type, bodyCtx, \{ onUploadFiles, onOpenWorkbench \}\)/)
  })
})
