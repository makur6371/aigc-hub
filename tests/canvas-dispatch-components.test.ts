import { describe, expect, it } from 'vitest'
import { assertNotMatches, readSource, sliceBlock } from './helpers/source-guard'
import { readNodeBodiesSource } from './helpers/canvas-node-bodies'

/**
 * 画布浮动层由 cardOpen 条件渲染。参数条 / 填写面板若以 Foo(ctx) 普通调用，
 * Foo 内部的 Hook 会挂到父组件并在条件变化时改变 Hook 顺序；
 * 必须通过 JSX 子组件渲染。此测试锁住这一类回归。
 *
 * 换用 `helpers/source-guard`：读文件统一换行、切片取不到就抛、
 * 负向断言必须带正向锚点 —— 旧版正是「正则失配 → 空匹配 → 永远绿」的形态。
 */
// Q-303：node-bodies 已拆成 node-bodies/ 目录（6 个模块 + barrel），
// 守卫要扫**整个目录** —— 只扫 barrel 会让这些断言全部空跑。
const source = readNodeBodiesSource()
const functionBlock = (name: string) => sliceBlock(source, `export function ${name}(`)

describe('画布浮动层组件渲染契约', () => {
  for (const name of ['dispatchNodeBody', 'dispatchParamBar', 'dispatchPromptPanel']) {
    it(`${name} 不得把 Hook 组件当普通函数直接调用`, () => {
      const block = functionBlock(name)
      expect(block).toMatch(/\{\.\.\.ctx\}/)
      // 禁止分派块内出现任何「组件名(」调用形态（含带第二参数的 Foo(ctx, extra)）；
      // 锚点用 `{...ctx}` 正向命中，证明确实读到了分派实现而不是空片段。
      assertNotMatches(
        block,
        /(?<!function\s)\b[A-Z][A-Za-z0-9]*(?:Body|ParamBar|PromptPanel|Panel)\s*\(/,
        `${name} 里出现了把 Hook 组件当普通函数调用的写法（会破坏 Hook 顺序，必须走 JSX）`,
        /\{\.\.\.ctx\}/,
      )
    })
  }

  it('带自动规格纠正的图片与视频参数条独立成为子组件', () => {
    const block = functionBlock('dispatchParamBar')
    expect(block).toContain('<ImageGenParamBar {...ctx} />')
    expect(block).toContain('<VideoGenParamBar {...ctx} />')
  })

  it('整个 node-bodies.tsx：Hook 组件只允许定义与 JSX 渲染，不允许普通函数调用（Q-D24）', () => {
    // 历史事故根因是「可被当普通函数调用的组件形状」：任何一处 Foo(ctx[, extra])
    // 都会把组件内的 Hook 挂到调用方的 Hook 序列。除了 export function 定义本身，
    // 全文件不允许出现组件名跟左括号的调用形态。
    const violations = source.match(/(?<!function\s)\b[A-Z][A-Za-z0-9]*(?:Body|ParamBar|PromptPanel|Panel)\s*\(/g) ?? []
    expect(violations).toEqual([])
  })
})
