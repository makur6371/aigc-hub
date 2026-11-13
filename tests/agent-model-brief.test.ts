import { describe, it, expect } from 'vitest'
import { buildModelBrief, type PlannerModelRow } from '@/lib/agent-plan'

/** 组装生产形态的模型行 */
const row = (o: Partial<PlannerModelRow> & { id: string; name: string; type: string }): PlannerModelRow => ({
  costPoints: 0,
  isFree: false,
  metadata: {},
  ...o,
})

describe('buildModelBrief —— 规划器模型菜单', () => {
  it('IMAGE：从 sizes 解出去重的 ratios/tiers，价格用档位价压缩', () => {
    const r = buildModelBrief([row({
      id: 'm1', name: 'demo-image', type: 'IMAGE', costPoints: 5,
      metadata: {
        modes: ['text', 'singleImage', 'multiReference'],
        sizes: ['1:1@1K', '1:1@2K', '1:1@4K', '3:4@1K', '3:4@2K', '3:4@4K', '16:9@2K', '16:9@4K'],
        tierCost1K: 5, tierCost2K: 6, tierCost4K: 7,
      },
    })])[0]
    expect(r.capability).toBe('image')
    expect(r.free).toBe(false)
    expect(r.cost).toBe('5/6/7')
    // 去重 + 不透传原始数组
    expect(r.ratios).toBe('1:1,3:4,16:9')
    expect(r.tiers).toBe('1K,2K,4K')
    expect(r.sizePairs).toContain('16:9@2K')
    expect(r.sizePairs).not.toContain('16:9@1K')
    expect(r.ref).toBe('multi')
  })

  it('部分档位缺价 → 只列有的档位价', () => {
    const r = buildModelBrief([row({
      id: 'm2', name: 'a', type: 'IMAGE',
      metadata: { sizes: ['1:1@1K', '1:1@2K'], tierCost1K: 3, tierCost2K: 6 },
    })])[0]
    expect(r.cost).toBe('3/6')
    expect(r.tiers).toBe('1K,2K')
  })

  it('无档位价 → 回退统一单价；无 sizes → ratios/tiers 空串', () => {
    const r = buildModelBrief([row({ id: 'm3', name: 'b', type: 'IMAGE', costPoints: 2 })])[0]
    expect(r.cost).toBe('2')
    expect(r.ratios).toBe('')
    expect(r.tiers).toBe('')
  })

  it('free 判定：isFree=true 或 costPoints=0', () => {
    const rs = buildModelBrief([
      row({ id: 'f1', name: 'free1', type: 'IMAGE', isFree: true, costPoints: 9 }),
      row({ id: 'f2', name: 'free2', type: 'TEXT', isFree: false, costPoints: 0 }),
      row({ id: 'f3', name: 'paid', type: 'TEXT', isFree: false, costPoints: 3 }),
    ])
    expect(rs.map((r) => r.free)).toEqual([true, true, false])
  })

  it('metadata.kind=ocr 的模型不进菜单（曾因 capability=vision 被误当通用模型）', () => {
    const rs = buildModelBrief([
      row({ id: 'ocr1', name: 'demo-ocr', type: 'VISION', metadata: { kind: 'ocr' } }),
      row({ id: 'ok1', name: 'normal', type: 'VISION' }),
    ])
    expect(rs.map((r) => r.id)).toEqual(['ok1'])
  })

  it('ref 形态取 modes 里最强的（multi > single > text）', () => {
    const rs = buildModelBrief([
      row({ id: 'r1', name: 'a', type: 'IMAGE', metadata: { modes: ['text'] } }),
      row({ id: 'r2', name: 'b', type: 'IMAGE', metadata: { modes: ['text', 'singleImage'] } }),
      row({ id: 'r3', name: 'c', type: 'IMAGE', metadata: { modes: ['text', 'singleImage', 'multiReference'] } }),
    ])
    expect(rs.map((r) => r.ref)).toEqual(['text', 'single', 'multi'])
  })

  it('畸形 metadata 不崩（null / sizes 含非字符串项）', () => {
    const rs = buildModelBrief([
      row({ id: 'x1', name: 'a', type: 'IMAGE', metadata: null }),
      row({ id: 'x2', name: 'b', type: 'IMAGE', metadata: { sizes: [1, '3:4@1K', null] } }),
    ])
    expect(rs).toHaveLength(2)
    expect(rs[1].ratios).toBe('3:4')
  })

  it('旧格式 宽x高 也进入 Planner 能力清单', () => {
    const r = buildModelBrief([row({
      id: 'legacy',
      name: 'legacy-image',
      type: 'IMAGE',
      metadata: { sizes: ['1536x1024'] },
    })])[0]
    expect(r.ratios).toBe('3:2')
    expect(r.tiers).toBe('1K')
    expect(r.sizePairs).toBe('3:2@1K')
  })

  it('token 预算：15 个真实规模模型的菜单 < 6KB', () => {
    const rows: PlannerModelRow[] = Array.from({ length: 15 }, (_, i) => row({
      id: 'id' + i,
      name: 'model-' + i,
      type: i % 3 === 0 ? 'IMAGE' : i % 3 === 1 ? 'VISION' : 'TEXT',
      costPoints: 5,
      metadata: i % 3 === 0
        ? { modes: ['text', 'singleImage', 'multiReference'], sizes: ['1:1@1K','1:1@2K','1:1@4K','3:4@1K','3:4@2K','3:4@4K','16:9@1K','16:9@2K','16:9@4K'], tierCost1K: 5, tierCost2K: 6, tierCost4K: 7 }
        : { think: true },
    }))
    const json = JSON.stringify(buildModelBrief(rows))
    console.log('15 模型菜单实际字节:', json.length)
    expect(json.length).toBeLessThan(6000)
  })

  it('TEXT/VIDEO：无 ratios/tiers 概念，cost 为统一价', () => {
    const rs = buildModelBrief([
      row({ id: 't1', name: 'llm', type: 'TEXT', costPoints: 1 }),
      row({ id: 'v1', name: 'vid', type: 'VIDEO', costPoints: 0, isFree: false }),
    ])
    expect(rs[0].ratios).toBe('')
    expect(rs[0].cost).toBe('1')
    expect(rs[1].capability).toBe('video')
    // 视频未声明比例时与 validateVideoParams 同口径：展示常用比例兜底，避免 planner 猜
    expect(rs[1].ratios).toBe('16:9,9:16,1:1,4:3,3:4,21:9')
  })

  it('VIDEO：比例/分辨率/时长一律来自 metadata.video.constraints', () => {
    const r = buildModelBrief([row({
      id: 'v2', name: 'H3', type: 'VIDEO', costPoints: 6,
      metadata: {
        modes: ['text', 'singleImage'],
        video: { constraints: { ratios: ['16:9', '9:16', '3:4'], resolutions: ['768P', '1080P'], durations: [5, 10] } },
      },
    })])[0]
    expect(r.ratios).toBe('16:9,9:16,3:4')
    expect(r.resolutions).toBe('768P,1080P')
    expect(r.durations).toBe('5,10')
  })
})
