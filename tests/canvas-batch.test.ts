import { describe, it, expect } from 'vitest'
import {
  batchCopyPosition,
  batchLayoutForHeight,
  DEFAULT_BATCH_LAYOUT,
} from '@/lib/canvas-batch'

// 为什么测这个：这是「前后端批量展开位置」的唯一公式。
// 历史问题（INV-2026-0919-04 的 D-01）：两边各写一套，已经漂移（前端按节点高度、
// 后端硬编码 120），导致同一批副本在前端显示时重叠错位。
// 这些用例把公式钉死，谁改都会立刻失败。

describe('batchCopyPosition —— 副本坐标', () => {
  const layout = { offsetX: 48, stepX: 16, stepY: 160 }

  it('第 1 份副本：主本 + offsetX / 1×stepY', () => {
    expect(batchCopyPosition({ x: 100, y: 200 }, 1, layout)).toEqual({ x: 164, y: 360 })
  })

  it('第 3 份副本：x 按 stepX 递增、y 按 stepY 递增', () => {
    expect(batchCopyPosition({ x: 100, y: 200 }, 3, layout)).toEqual({ x: 196, y: 680 })
  })

  it('序号越大越靠右下（不会重叠）', () => {
    const base = { x: 0, y: 0 }
    const p1 = batchCopyPosition(base, 1, layout)
    const p2 = batchCopyPosition(base, 2, layout)
    expect(p2.x).toBeGreaterThan(p1.x)
    expect(p2.y).toBeGreaterThan(p1.y)
  })

  it('主本坐标变化时副本整体平移（相对关系不变）', () => {
    const a = batchCopyPosition({ x: 0, y: 0 }, 2, layout)
    const b = batchCopyPosition({ x: 500, y: 300 }, 2, layout)
    expect(b.x - a.x).toBe(500)
    expect(b.y - a.y).toBe(300)
  })

  it('同一输入必得同一结果（确定性，前后端调用才可能一致）', () => {
    const p = { x: 33, y: 77 }
    expect(batchCopyPosition(p, 5, layout)).toEqual(batchCopyPosition(p, 5, layout))
  })
})

describe('batchLayoutForHeight —— 按节点高度推算', () => {
  it('垂直间距 = 节点高度 + 80（与前端原实现一致）', () => {
    expect(batchLayoutForHeight(200).stepY).toBe(280)
  })

  it('极小高度有下限（避免副本挤在一起）', () => {
    expect(batchLayoutForHeight(0).stepY).toBe(160)
    expect(batchLayoutForHeight(-50).stepY).toBe(160)
  })

  it('x 方向参数固定（不随高度变）', () => {
    const a = batchLayoutForHeight(100)
    const b = batchLayoutForHeight(500)
    expect(a.offsetX).toBe(b.offsetX)
    expect(a.stepX).toBe(b.stepX)
  })
})

describe('DEFAULT_BATCH_LAYOUT —— 后端默认值', () => {
  it('有合理默认（stepY 不能是 0，否则副本会叠在一起）', () => {
    expect(DEFAULT_BATCH_LAYOUT.stepY).toBeGreaterThan(0)
    expect(DEFAULT_BATCH_LAYOUT.offsetX).toBeGreaterThan(0)
  })

  it('默认值与「typical节点高度」推算结果同量级（不超过 2 倍）', () => {
    const typical = batchLayoutForHeight(120)
    expect(DEFAULT_BATCH_LAYOUT.stepY).toBeLessThanOrEqual(typical.stepY * 2)
    expect(DEFAULT_BATCH_LAYOUT.stepY).toBeGreaterThanOrEqual(typical.stepY / 2)
  })
})
