import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { readSource } from './helpers/source-guard'
import { BUILTIN_NODES } from '@/lib/canvas-nodes'
import { createGridGif, isGifSource, parseGridFrameSelection } from '@/lib/image-processor'
import { buildNineGridScript } from '@/lib/nine-grid-loop'
import { analyzeToolSlots, type ToolConnectionSnapshot, type ToolNodeSnapshot } from '@/lib/tool-slots'
import { buildRuns } from '@/lib/tool-run-plan'
import type { ExecutionConnection, ExecutionNode } from '@/lib/canvas-executor'
import { executeNode } from '@/lib/canvas-executor'

const COLORS = ['#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6', '#0ea5e9', '#10b981']

/** 生成一张 300×300 的 3×3 彩色网格（每格 100×100） */
async function makeGridDataUrl(): Promise<string> {
  const rects = COLORS.map((color, index) => {
    const x = (index % 3) * 100
    const y = Math.floor(index / 3) * 100
    return `<rect x="${x}" y="${y}" width="100" height="100" fill="${color}"/>`
  }).join('')
  const png = await sharp(Buffer.from(`<svg width="300" height="300">${rects}</svg>`)).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

/** 400×400 的 4×4 彩色网格（每格 100×100） */
async function makeGrid4DataUrl(): Promise<string> {
  const rects: string[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const index = row * 4 + col
      rects.push(`<rect x="${col * 100}" y="${row * 100}" width="100" height="100" fill="${COLORS[index % COLORS.length]}"/>`)
    }
  }
  const png = await sharp(Buffer.from(`<svg width="400" height="400">${rects.join('')}</svg>`)).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

describe('parseGridFrameSelection', () => {
  it('支持区间、逗号和混合写法', () => {
    expect(parseGridFrameSelection('1-9')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(parseGridFrameSelection('1,3,5-7')).toEqual([1, 3, 5, 6, 7])
    expect(parseGridFrameSelection('9-7')).toEqual([7, 8, 9])
  })

  it('留空 = 全部；越界忽略；重复只保留第一次', () => {
    expect(parseGridFrameSelection('')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(parseGridFrameSelection('0,1,1,10,3')).toEqual([1, 3])
  })
})

describe('createGridGif', () => {
  it('9 帧正序：页数、尺寸、延迟都正确，且首尾相同帧不会被合并', async () => {
    const result = await createGridGif(await makeGridDataUrl(), {
      delayMs: 100,
      frames: '1-9',
      trimPercent: 0,
      maxSize: 90,
      background: '#ffffff',
    })
    const meta = await sharp(result.gif, { animated: true }).metadata()
    expect(result.frames).toHaveLength(9)
    expect(result.frameCount).toBe(9)
    expect(result.width).toBe(90)
    expect(result.height).toBe(90)
    expect(meta.pages).toBe(9)
    expect(meta.pageHeight).toBe(90)
    expect(meta.width).toBe(90)
    expect(meta.delay).toEqual(Array(9).fill(100))
  })

  it('选 1,3,5 只出 3 帧；乒乓模式追加回程帧', async () => {
    const grid = await makeGridDataUrl()
    const selected = await createGridGif(grid, {
      frames: '1,3,5',
      delayMs: 120,
      trimPercent: 0,
      maxSize: 60,
    })
    expect(selected.frameCount).toBe(3)

    const pingpong = await createGridGif(grid, {
      frames: '1,2,3',
      mode: 'pingpong',
      delayMs: 120,
      trimPercent: 0,
      maxSize: 60,
    })
    const meta = await sharp(pingpong.gif, { animated: true }).metadata()
    // 1,2,3 → 1,2,3,2（再循环回 1；首尾不重复，否则会多停一拍）
    expect(pingpong.frameCount).toBe(4)
    expect(meta.pages).toBe(4)
  })

  it('4×4 十六帧：切 16 格并保留全部帧', async () => {
    const result = await createGridGif(await makeGrid4DataUrl(), {
      grid: '4×4（16帧）',
      frames: '1-16',
      delayMs: 80,
      trimPercent: 0,
      maxSize: 80,
    })
    const meta = await sharp(result.gif, { animated: true }).metadata()
    expect(result.frames).toHaveLength(16)
    expect(result.frameCount).toBe(16)
    expect(meta.pages).toBe(16)
    expect(meta.delay).toEqual(Array(16).fill(80))
  })

  it('非法帧选择给出可执行错误', async () => {
    await expect(createGridGif(await makeGridDataUrl(), { frames: '0,99' }))
      .rejects.toThrow(/没有有效帧/)
  })
})

describe('grid9-to-gif 节点接入', () => {
  it('节点定义存在，原图必填', () => {
    const node = BUILTIN_NODES.find((n) => n.type === 'grid9-to-gif')
    expect(node).toBeTruthy()
    expect(node?.inputs.imageUrl?.required).toBe(true)
    expect(node?.outputs.gifUrl?.type).toBe('image')
  })

  it('执行器有真实分支', () => {
    const src = readSource('src/lib/canvas-executor.ts')
    expect(src).toMatch(/case 'grid9-to-gif':/)
    expect(src).toMatch(/createGridGif/)
  })

  it('原生 GIF 输入直接透传，不再切格/重新编码', async () => {
    const out = await executeNode(
      { id: 'f', type: 'grid9-to-gif', label: 'GIF', category: 'image', inputs: {}, outputs: {} },
      { imageUrl: '/api/asset/u/abc.gif' },
      {} as never,
    )
    expect(out).toMatchObject({
      gifUrl: '/api/asset/u/abc.gif',
      nativeGif: true,
      frameCount: 0,
      frameUrls: [],
    })
  })

  it('无扩展名地址按字节判断是否 GIF', async () => {
    const gifData = `data:image/gif;base64,${Buffer.from('GIF89a' + '\0'.repeat(20), 'ascii').toString('base64')}`
    const pngData = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`
    expect(await isGifSource(gifData)).toBe(true)
    expect(await isGifSource(pngData)).toBe(false)
  })

  it('槽位识别出 GIF 结果、三个动图参数，执行计划包含整条链', () => {
    const nodes: ToolNodeSnapshot[] = [
      {
        id: 'g',
        type: 'nine-grid-loop',
        label: '九宫格循环帧',
        inputs: {
          script: buildNineGridScript({
            character: '角色',
            scene: '场景',
            actions: '1\n2\n3\n4\n5\n6\n7\n8\n9',
          }),
        },
      },
      {
        id: 'f',
        type: 'grid9-to-gif',
        label: '九宫格转GIF',
        inputs: { delayMs: 150, mode: '正序循环', frames: '1-9', trimPercent: 1, maxSize: 512 },
      },
    ]
    const connections: ToolConnectionSnapshot[] = [
      { sourceNodeId: 'g', sourcePort: 'imageUrl', targetNodeId: 'f', targetPort: 'imageUrl' },
    ]
    const { slots } = analyzeToolSlots(nodes, connections)
    expect(slots.filter((s) => s.type === 'text').map((s) => s.label))
      .toEqual(expect.arrayContaining(['帧间隔(毫秒)', '播放模式', '帧选择']))
    expect(slots.find((s) => s.type === 'result')?.targets).toEqual(
      expect.arrayContaining([
        { nodeId: 'g', port: 'imageUrl' },
        { nodeId: 'f', port: 'gifUrl' },
      ]),
    )

    const runs = buildRuns(
      nodes as unknown as ExecutionNode[],
      connections as unknown as ExecutionConnection[],
      slots,
      {},
    )
    expect(runs).toHaveLength(1)
    expect(runs[0].nodes.map((n) => n.type)).toEqual(expect.arrayContaining(['nine-grid-loop', 'grid9-to-gif']))
  })
})
