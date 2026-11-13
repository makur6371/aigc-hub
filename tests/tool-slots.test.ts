import { describe, it, expect } from 'vitest'
import { ratioFromSize, reconcileParamSlots } from '@/lib/tool-slots'

// 为什么测这个：
//   1) ratioFromSize 决定「工具识别出的尺寸该显示成什么比例」——判错用户看到错的比例标签。
//   2) reconcileParamSlots 决定「工具面板出现哪些参数槽」——判错运营配好的工具会少参数、
//      或出现不该有的参数（历史真出过「只给第一个节点选了模型，其余自动兜底」）。

describe('ratioFromSize —— 像素尺寸反推比例', () => {
  it('精确比例直接命中预设', () => {
    expect(ratioFromSize(1024, 1024)).toBe('1:1')
    expect(ratioFromSize(1920, 1080)).toBe('16:9')
    expect(ratioFromSize(1080, 1920)).toBe('9:16')
    expect(ratioFromSize(1200, 900)).toBe('4:3')
    expect(ratioFromSize(900, 1200)).toBe('3:4')
  })

  it('非精确比例在 2% 容差内归一到预设', () => {
    // 1024x1536 是 2:3；1536x1024 是 3:2
    expect(ratioFromSize(1536, 1024)).toBe('3:2')
    expect(ratioFromSize(1024, 1536)).toBe('2:3')
    // 略微偏离 16:9（1536/864 = 1.777…，标准 16:9 = 1.7778）
    expect(ratioFromSize(1536, 864)).toBe('16:9')
  })

  it('超出容差的非标比例：按约简后的整数比输出', () => {
    // 5:4 = 1.25 不在预设里（预设只有 7 种），应输出约简比
    const r = ratioFromSize(1280, 1024)
    expect(r).toBe('5:4')
  })

  it('非法输入返回 null（而不是猜一个比例）', () => {
    expect(ratioFromSize(0, 100)).toBeNull()
    expect(ratioFromSize(100, 0)).toBeNull()
    expect(ratioFromSize(undefined, 100)).toBeNull()
    expect(ratioFromSize('abc', 100)).toBeNull()
  })

  it('大尺寸同样正确（4K 档）', () => {
    expect(ratioFromSize(3840, 2160)).toBe('16:9')
    expect(ratioFromSize(2880, 2880)).toBe('1:1')
    expect(ratioFromSize(4096, 4096)).toBe('1:1')
  })
})

describe('reconcileParamSlots —— 槽位派生', () => {
  // 构造最小工作流：一个上传节点 → 一个生图节点
  const node = (id: string, type: string, inputs: Record<string, unknown> = {}) => ({
    id, type, label: id, inputs,
  })
  const conn = (from: string, to: string) => ({ sourceNodeId: from, sourcePort: 'out', targetNodeId: to, targetPort: 'in' })

  it('空工作流 → 不产出槽位（不崩）', () => {
    expect(reconcileParamSlots([], [], [])).toEqual([])
  })

  it('已有槽位被保留（不丢弃运营手配的配置）', () => {
    const slots = [{
      id: 's1', type: 'text' as const, label: '提示词',
      targets: [{ nodeId: 'n1', inputKey: 'prompt', port: 'in' }],
    }]
    const out = reconcileParamSlots([node('n1', 'image-generate')], [], slots)
    expect(out.some((s) => s.id === 's1')).toBe(true)
  })

  // 实测行为：参数槽的 required 来自识别结果，不继承存储值。
  // reconcileParamSlots 只保留作者的 label / hidden（见源码 overrideByKey），
  // 所以手填 required=true 不会生效 —— 面板是否必填由识别逻辑决定。
  it('参数槽的 label 与 hidden 继承作者配置', () => {
    const slots = [{
      id: 'm1', type: 'model' as const, label: '我的模型槽', hidden: true,
      targets: [{ nodeId: 'n1', inputKey: 'model', port: 'in' }],
    }]
    const out = reconcileParamSlots([node('n1', 'image-generate')], [], slots)
    const m = out.find((s) => s.type === 'model')
    expect(m?.label).toBe('我的模型槽')
    expect(m?.hidden).toBe(true)
  })

  it('声明的 target 节点不存在时，槽位仍返回（由调用方决定是否提示）', () => {
    const slots = [{
      id: 'x1', type: 'text' as const, label: '幽灵槽',
      targets: [{ nodeId: 'not-exist', inputKey: 'prompt', port: 'in' }],
    }]
    const out = reconcileParamSlots([node('n1', 'image-generate')], [], slots)
    expect(out.some((s) => s.id === 'x1')).toBe(true)
  })

  it('幂等：同样输入调用两次结果一致（避免面板抖动）', () => {
    const nodes = [node('n1', 'image-generate', { prompt: 'x', model: 'm' })]
    const conns = [conn('n1', 'n1')]
    const a = reconcileParamSlots(nodes, conns, [])
    const b = reconcileParamSlots(nodes, conns, [])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
