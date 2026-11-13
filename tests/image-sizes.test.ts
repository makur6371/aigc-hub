import { describe, it, expect } from 'vitest'
import {
  ASPECT_RATIOS,
  RES_TIERS,
  SIZE_TABLE,
  encodeSize,
  decodeSize,
  expandSizes,
  findImageSize,
  getImageCapabilities,
  resolveImageSizeForModel,
  supportsImageSize,
} from '@/lib/image-sizes'

// 为什么测这个：尺寸映射算错 = 用户要 3:4 却出 1:1（线上真实发生过）。
// 这张表是「比例 × 档位 → 像素」的唯一事实源，必须锁死。

describe('SIZE_TABLE —— 尺寸表自身', () => {
  it('每个比例都覆盖全部 3 个档位', () => {
    for (const ratio of ASPECT_RATIOS) {
      for (const tier of RES_TIERS) {
        expect(SIZE_TABLE[ratio]?.[tier], `缺 ${ratio}@${tier}`).toMatch(/^\d+x\d+$/)
      }
    }
  })

  it('宽高比与声明的比例一致（容差 1%，因为像素需取整）', () => {
    for (const ratio of ASPECT_RATIOS) {
      const [rw, rh] = ratio.split(':').map(Number)
      const target = rw / rh
      for (const tier of RES_TIERS) {
        const [w, h] = SIZE_TABLE[ratio][tier].split('x').map(Number)
        const actual = w / h
        // 允许 1% 偏差：像素取整会引入误差（如 21:9 = 2.333 vs 2016/864 = 2.3333）
        expect(Math.abs(actual - target) / target, `${ratio}@${tier} 比例不符`).toBeLessThan(0.01)
      }
    }
  })

  it('档位越大像素越多（1K < 2K < 4K）', () => {
    for (const ratio of ASPECT_RATIOS) {
      const area = (t: string) => {
        const [w, h] = SIZE_TABLE[ratio][t].split('x').map(Number)
        return w * h
      }
      expect(area('1K'), ratio).toBeLessThan(area('2K'))
      expect(area('2K'), ratio).toBeLessThan(area('4K'))
    }
  })
})

describe('极端长条比例 4:1 / 1:4 / 8:1 / 1:8', () => {
  // 为什么单测：这几个比例是「上游支持但全局表原本没有」的典型 ——
  // 表里没有 → resolveSize 兜底成 1:1、decodeSize 反查不到档位（档位差价失效）。
  const EXTREMES = ['4:1', '1:4', '8:1', '1:8']

  it('已登记进 ASPECT_RATIOS（可被后台勾选、可被 decodeSize 反查）', () => {
    for (const r of EXTREMES) expect(ASPECT_RATIOS as readonly string[]).toContain(r)
  })

  it('每个极端比例都覆盖 3 个档位，且面积随档位递增', () => {
    for (const r of EXTREMES) {
      const area = (t: string) => {
        const [w, h] = SIZE_TABLE[r][t].split('x').map(Number)
        return w * h
      }
      for (const t of RES_TIERS) expect(SIZE_TABLE[r]?.[t], `${r}@${t}`).toMatch(/^\d+x\d+$/)
      expect(area('1K'), r).toBeLessThan(area('2K'))
      expect(area('2K'), r).toBeLessThan(area('4K'))
    }
  })

  it('像素比例与声明一致', () => {
    for (const r of EXTREMES) {
      const [rw, rh] = r.split(':').map(Number)
      for (const t of RES_TIERS) {
        const [w, h] = SIZE_TABLE[r][t].split('x').map(Number)
        expect(Math.abs(w / h - rw / rh) / (rw / rh), `${r}@${t}`).toBeLessThan(0.01)
      }
    }
  })

  it('不会被前面的常用比例兜底顶掉（数组顺序：极端比例在末尾）', () => {
    // slice(0, 8) 是各处「模型未配 sizes」时的常用比例兜底，不能被极端比例污染
    expect([...ASPECT_RATIOS].slice(0, 8)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9'])
  })

  it('decodeSize 能精确反查出比例 + 档位（档位差价计费依赖它）', () => {
    expect(decodeSize('2048x512')).toMatchObject({ ratio: '4:1', tier: '1K' })
    expect(decodeSize('512x2048')).toMatchObject({ ratio: '1:4', tier: '1K' })
    expect(decodeSize('8160x1020')).toMatchObject({ ratio: '8:1', tier: '4K' })
    expect(decodeSize('1020x8160')).toMatchObject({ ratio: '1:8', tier: '4K' })
  })

  it('expandSizes 能展开极端比例（后台勾选后能生成 metadata.sizes）', () => {
    expect(expandSizes(['4:1'], ['1K', '2K'])).toEqual(['4:1@1K', '4:1@2K'])
  })
})

describe('encodeSize / decodeSize —— 编解码往返', () => {
  it('编码格式是 比例@档位', () => {
    expect(encodeSize('16:9', '2K')).toBe('16:9@2K')
  })

  it('往返一致：encode → decode 还原比例与档位', () => {
    for (const ratio of ASPECT_RATIOS) {
      for (const tier of RES_TIERS) {
        const d = decodeSize(encodeSize(ratio, tier))
        expect(d?.ratio, ratio).toBe(ratio)
        expect(d?.tier, ratio).toBe(tier)
      }
    }
  })

  it('decoded 宽高与表一致', () => {
    const d = decodeSize('3:4@2K')
    expect(d).toEqual({ ratio: '3:4', tier: '2K', width: 1536, height: 2048 })
  })

  it('未知比例/档位返回 null（而不是猜一个尺寸）', () => {
    expect(decodeSize('99:1@1K')).toBeNull()
    expect(decodeSize('1:1@8K')).toBeNull()
  })

  // 兼容旧格式：老数据里 metadata.sizes 存的是 "1536x1024" 直传像素
  it('旧格式 宽x高：反查出比例与档位', () => {
    const d = decodeSize('1536x1024')
    expect(d).toEqual({ ratio: '3:2', tier: '1K', width: 1536, height: 1024 })
  })

  it('旧格式但表里没有的尺寸：保留原始宽高，比例按宽:高标记', () => {
    const d = decodeSize('1234x567')
    expect(d).toEqual({ ratio: '1234:567', tier: '', width: 1234, height: 567 })
  })

  it('非法输入返回 null', () => {
    expect(decodeSize('')).toBeNull()
    expect(decodeSize('abc')).toBeNull()
    expect(decodeSize('0x0')).toBeNull()
  })
})

describe('expandSizes —— 勾选项展开', () => {
  it('比例 × 档位 全组合', () => {
    const out = expandSizes(['1:1', '16:9'], ['1K', '2K'])
    expect(out).toEqual(['1:1@1K', '1:1@2K', '16:9@1K', '16:9@2K'])
  })

  it('过滤掉表里不存在的组合（不产出无效项）', () => {
    const out = expandSizes(['1:1', '99:1'], ['1K'])
    expect(out).toEqual(['1:1@1K'])
  })

  it('空输入返回空数组', () => {
    expect(expandSizes([], ['1K'])).toEqual([])
    expect(expandSizes(['1:1'], [])).toEqual([])
  })
})

describe('图片模型能力解析 —— 三条入口共用口径', () => {
  it('兼容旧格式 宽x高，Agent 不会再把 1536x1024 当成比例名', () => {
    const cap = getImageCapabilities({ metadata: { sizes: ['1536x1024'] } })
    expect(cap.declared).toBe(true)
    expect(cap.ratios).toEqual(['3:2'])
    expect(cap.tiers).toEqual(['1K'])
    expect(findImageSize(cap, '3:2', '1K')).toMatchObject({ width: 1536, height: 1024 })
  })

  it('模型只声明 1K 时，不产生 2K/4K，也不允许非法组合', () => {
    const cap = getImageCapabilities({ metadata: { sizes: ['16:9@1K', '1:1@1K'] } })
    expect(cap.tiers).toEqual(['1K'])
    expect(cap.tiersByRatio['16:9']).toEqual(['1K'])
    expect(supportsImageSize(cap, '16:9', '1K')).toBe(true)
    expect(supportsImageSize(cap, '16:9', '4K')).toBe(false)
  })

  it('比例和档位都存在但组合不存在时仍判非法', () => {
    const cap = getImageCapabilities({ metadata: { sizes: ['16:9@1K', '1:1@4K'] } })
    expect(cap.ratios).toEqual(['16:9', '1:1'])
    expect(cap.tiers).toEqual(['1K', '4K'])
    expect(supportsImageSize(cap, '16:9', '4K')).toBe(false)
  })

  it('请求 4K 但模型只有 1K 时，计费尺寸吸附到同比例 1K', () => {
    const metadata = { sizes: ['16:9@1K', '1:1@4K'] }
    expect(resolveImageSizeForModel(metadata, 3840, 2160)).toMatchObject({
      ratio: '16:9',
      tier: '1K',
      width: 1536,
      height: 864,
    })
  })

  it('未声明 sizes 的旧模型保持原有像素，不做主观降档', () => {
    expect(resolveImageSizeForModel({}, 3840, 2160)).toMatchObject({
      width: 3840,
      height: 2160,
    })
  })
})
