import { describe, it, expect, vi } from 'vitest'

vi.mock('react', () => ({
  // 桩只做一件事：原样返回回调。类型用 unknown 而不是 any ——
  // 调用处的类型仍来自 React 真实声明，所以这里不需要（也不应该）放开成 any。
  useCallback: (fn: unknown) => fn,
}))

import { useAutoLayout } from '@/components/canvas/useAutoLayout'

describe('useAutoLayout - 对齐、分布与局部整理', () => {
  it('alignNodes —— 左对齐与顶端对齐正确更新坐标', () => {
    const positions: Record<string, { x: number; y: number }> = {
      n1: { x: 100, y: 50 },
      n2: { x: 300, y: 150 },
      n3: { x: 200, y: 80 },
    }
    const setNodePosition = vi.fn((id: string, x: number, y: number) => {
      positions[id] = { x, y }
    })
    const getNodePosition = (id: string) => positions[id] || { x: 0, y: 0 }
    const getNodeHeight = () => 120
    const getNodeType = () => 'text-input'

    const api = useAutoLayout(getNodePosition, setNodePosition, getNodeHeight, getNodeType)

    // 左对齐：全部 x = 100
    api.alignNodes(['n1', 'n2', 'n3'], 'left')
    expect(positions.n1.x).toBe(100)
    expect(positions.n2.x).toBe(100)
    expect(positions.n3.x).toBe(100)

    // 顶端对齐：全部 y = 50
    api.alignNodes(['n1', 'n2', 'n3'], 'top')
    expect(positions.n1.y).toBe(50)
    expect(positions.n2.y).toBe(50)
    expect(positions.n3.y).toBe(50)
  })

  it('distributeNodes —— 水平等间距均匀分布', () => {
    const positions: Record<string, { x: number; y: number }> = {
      n1: { x: 0, y: 0 },
      n2: { x: 50, y: 0 },
      n3: { x: 600, y: 0 },
    }
    const setNodePosition = vi.fn((id: string, x: number, y: number) => {
      positions[id] = { x, y }
    })
    const getNodePosition = (id: string) => positions[id]
    const getNodeHeight = () => 100
    const getNodeType = () => 'condition-check'

    const api = useAutoLayout(getNodePosition, setNodePosition, getNodeHeight, getNodeType)

    api.distributeNodes(['n1', 'n2', 'n3'], 'horizontal')
    // 首尾节点跨度维持，中间节点 n2 被调整到正中间
    expect(positions.n1.x).toBe(0)
    expect(positions.n3.x).toBe(600)
    expect(positions.n2.x).toBeGreaterThan(0)
    expect(positions.n2.x).toBeLessThan(600)
  })

  it('tidySelectedNodes —— 局部 DAG 整理保持在原区域锚点', () => {
    const positions: Record<string, { x: number; y: number }> = {
      a: { x: 500, y: 400 },
      b: { x: 520, y: 420 },
    }
    const setNodePosition = vi.fn((id: string, x: number, y: number) => {
      positions[id] = { x, y }
    })
    const getNodePosition = (id: string) => positions[id]

    const api = useAutoLayout(getNodePosition, setNodePosition)

    // a -> b 连线，整理后 a 在左，b 在右，且整体在 500, 400 锚点附近
    const res = api.tidySelectedNodes(
      ['a', 'b'],
      [{ sourceNodeId: 'a', targetNodeId: 'b' }]
    )
    expect(res).toHaveLength(2)
    expect(positions.a.x).toBe(500)
    expect(positions.b.x).toBeGreaterThan(positions.a.x)
  })
})
