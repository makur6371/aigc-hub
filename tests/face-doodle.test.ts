import { describe, it, expect } from 'vitest'
import {
  inferSliceGrid,
  suppressDuplicates,
  inferMissingViews,
  expandTinyBox,
  seededRandom,
  drawScribbleFace,
  drawScribbleAll,
  normalizeBox,
  DOODLE_DEFAULTS,
} from '@/lib/face-doodle'

/**
 * 人脸智能涂鸦算法纯函数回归 —— 从 Face FX Studio 提取重写的核心逻辑。
 * 这些公式是「同图同参数 → 同涂鸦」的确定性契约：预览/导出/重跑必须一致，
 * 任何一侧改动（如网格推断、NMS、绘制参数映射）都会被这里钉死。
 */

// ---------- 1. 网格推断 ----------

describe('inferSliceGrid —— 按图片形态选检测网格', () => {
  it('四视图横条 (aspect≥1.8)：4x1；极端横条 (≥3.2)：5x1', () => {
    expect(inferSliceGrid(3200, 1200)).toEqual({ cols: 4, rows: 1 }) // aspect≈2.67
    expect(inferSliceGrid(4096, 1024)).toEqual({ cols: 5, rows: 1 }) // aspect=4
  })
  it('竖条分镜 (aspect≤0.6)：1x4', () => {
    expect(inferSliceGrid(1024, 2048)).toEqual({ cols: 1, rows: 4 })
    expect(inferSliceGrid(600, 1100)).toEqual({ cols: 1, rows: 4 }) // aspect≈0.55
  })
  it('大图分镜 (长边≥1600 且非横/竖条)：3x2', () => {
    expect(inferSliceGrid(1920, 1080)).toEqual({ cols: 3, rows: 2 })
    expect(inferSliceGrid(1400, 1700)).toEqual({ cols: 3, rows: 2 }) // aspect≈0.82
  })
  it('普通图：2x2', () => {
    expect(inferSliceGrid(1024, 1024)).toEqual({ cols: 2, rows: 2 })
    expect(inferSliceGrid(800, 1000)).toEqual({ cols: 2, rows: 2 })
  })
})

// ---------- 2. NMS 与兜底 ----------

describe('suppressDuplicates —— IoU 去重', () => {
  it('高重叠框只留最高分（全图+切片双检的重复）', () => {
    const boxes = [
      { x: 100, y: 100, w: 200, h: 200, score: 0.9 },
      { x: 110, y: 105, w: 200, h: 200, score: 0.7 }, // IoU ≈ 0.78
      { x: 800, y: 100, w: 200, h: 200, score: 0.6 }, // 独立框
    ]
    const kept = suppressDuplicates(boxes)
    expect(kept).toHaveLength(2)
    expect(kept[0].score).toBe(0.9)
  })
  it('低重叠（<阈值）都保留', () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 100, score: 0.9 },
      { x: 500, y: 0, w: 100, h: 100, score: 0.8 },
    ]
    expect(suppressDuplicates(boxes)).toHaveLength(2)
  })
})

describe('inferMissingViews —— 背影兜底', () => {
  it('4 列横条检出 2 张脸 → 缺失 2 列各补一个兜底框', () => {
    const imgW = 3200
    const colW = imgW / 4
    const faces = [
      { x: 100, y: 400, w: 500, h: 600 },
      { x: colW + 100, y: 420, w: 520, h: 620 },
    ]
    const out = inferMissingViews(faces, imgW, 4)
    expect(out).toHaveLength(4)
    const fallbacks = out.filter((f) => f.isFallback)
    expect(fallbacks).toHaveLength(2)
    // 兜底框落在缺失列（第 3、4 列）
    for (const f of fallbacks) {
      const col = Math.floor((f.x + f.w / 2) / colW)
      expect(col).toBeGreaterThanOrEqual(2)
    }
  })
  it('检出数 ≥ 列数时不补', () => {
    const faces = [
      { x: 100, y: 400, w: 500, h: 600 },
      { x: 900, y: 400, w: 500, h: 600 },
      { x: 1700, y: 400, w: 500, h: 600 },
      { x: 2500, y: 400, w: 500, h: 600 },
    ]
    expect(inferMissingViews(faces, 3200, 4)).toHaveLength(4)
  })
})

describe('normalizeBox —— 归一化→像素', () => {
  it('中心点+比例换算为左上角+宽高（切片偏移正确叠加）', () => {
    const b = normalizeBox({ xCenter: 0.5, yCenter: 0.5, width: 0.2, height: 0.3, score: 0.9 }, 100, 200, 400, 200)
    expect(b.x).toBe(100 + (0.5 * 400 - 0.2 * 400 / 2)) // 260
    expect(b.y).toBe(200 + (0.5 * 200 - 0.3 * 200 / 2)) // 270
    expect(b.w).toBe(80)
    expect(b.h).toBe(60)
  })
})

// ---------- 3. 手动框选 ----------

describe('expandTinyBox —— 点击/小拖拽自动扩默认脸框', () => {
  it('拖拽 <15px → 以点击点为中心生成默认框（宽=图宽9%，高=宽x1.25）', () => {
    const box = expandTinyBox(500, 400, 508, 406, 2000, 15)
    expect(box.isManual).toBe(true)
    expect(box.w).toBe(180) // 2000*0.09
    expect(box.h).toBe(225)
    expect(box.x).toBe(500 - 90) // 以点击点为中心
    expect(box.y).toBe(400 - 112.5)
  })
  it('正常拖拽 ≥15px → 原样成框', () => {
    const box = expandTinyBox(100, 100, 200, 200, 2000, 15)
    expect(box).toEqual({ x: 100, y: 100, w: 100, h: 100, isManual: true })
  })
})

// ---------- 4. 确定性随机与绘制 ----------

describe('seededRandom —— 确定性伪随机', () => {
  it('同种子同结果、值域 [0,1)', () => {
    expect(seededRandom(42)).toBe(seededRandom(42))
    for (let i = 0; i < 50; i++) {
      const v = seededRandom(i * 1.37)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('drawScribbleFace —— 涂鸦绘制（ctx 调用序列契约）', () => {
  /** 记录型 mock ctx：断言绘制调用形态，不依赖 DOM */
  function makeMockCtx() {
    const calls = { beginPath: 0, stroke: 0, bezier: 0, lineTo: 0, moveTo: 0, save: 0, restore: 0, lineWidths: [] as number[] }
    const ctx = {
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
      save: () => { calls.save++ },
      restore: () => { calls.restore++ },
      beginPath: () => { calls.beginPath++ },
      stroke: () => { calls.stroke++; calls.lineWidths.push(ctx.lineWidth) },
      moveTo: () => { calls.moveTo++ },
      lineTo: () => { calls.lineTo++ },
      bezierCurveTo: () => { calls.bezier++ },
    }
    return { ctx, calls }
  }

  it('一次绘制 = 2 段路径（主线+斜线）、save/restore 配对、线宽按脸宽自适应', () => {
    const { ctx, calls } = makeMockCtx()
    drawScribbleFace(ctx, { x: 100, y: 100, w: 180, h: 240 }, { density: 42, strokeWidth: 2.2, spike: 1.25, coverage: 1.1 }, 88)
    expect(calls.save).toBe(1)
    expect(calls.restore).toBe(1)
    expect(calls.beginPath).toBe(2)
    expect(calls.stroke).toBe(2)
    // 42 笔主线 → 42 段贝塞尔 + 回旋死结（i%7==0 且 i>0：7,14,21,28,35 = 5 个）
    expect(calls.bezier).toBe(42 + 5)
    expect(calls.lineTo).toBe(3)
    expect(calls.moveTo).toBe(1 + 3) // 主线 1 + 斜线 3
    // 线宽 = max(1.5, (180/180)*2.2) = 2.2
    expect(calls.lineWidths[0]).toBeCloseTo(2.2)
  })

  it('同框同参数同种子 → 调用序列完全一致（重跑可复现）', () => {
    const a = makeMockCtx()
    const b = makeMockCtx()
    const box = { x: 50, y: 60, w: 200, h: 260 }
    const params = { density: 60, strokeWidth: 1.5, spike: 1.0, coverage: 0.9 }
    drawScribbleFace(a.ctx, box, params, 7)
    drawScribbleFace(b.ctx, box, params, 7)
    expect(a.calls.bezier).toBe(b.calls.bezier)
    expect(a.calls.lineWidths).toEqual(b.calls.lineWidths)
  })

  it('密度 0/负数有下限（至少 3 笔，不产生空路径）', () => {
    const { ctx, calls } = makeMockCtx()
    drawScribbleFace(ctx, { x: 0, y: 0, w: 100, h: 100 }, { density: 0, strokeWidth: 2, spike: 1, coverage: 1 }, 1)
    expect(calls.bezier).toBeGreaterThanOrEqual(3)
  })
})

describe('drawScribbleAll —— 多框种子错开', () => {
  it('每个框种子不同（baseSeed + idx*433）且绘制次数=框数', () => {
    const strokes: number[] = []
    const ctx = {
      strokeStyle: '', lineWidth: 1, lineCap: 'round' as const, lineJoin: 'round' as const,
      save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, bezierCurveTo: () => {},
      stroke: () => strokes.push(1),
    }
    drawScribbleAll(ctx, [{ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 100, h: 100 }, { x: 600, y: 0, w: 100, h: 100 }], { density: 30, strokeWidth: 2, spike: 1.25, coverage: 1.1 })
    expect(strokes).toHaveLength(6) // 3 框 × 2 次 stroke（主线+斜线）
  })
})

// ---------- 5. 默认参数 ----------

describe('DOODLE_DEFAULTS —— 与节点定义 defaultValue 对齐', () => {
  it('默认值：42 笔 / 2.2px / 1.25 飞白 / 1.1 遮挡 / 0.18 阈值', () => {
    expect(DOODLE_DEFAULTS.density).toBe(42)
    expect(DOODLE_DEFAULTS.strokeWidth).toBe(2.2)
    expect(DOODLE_DEFAULTS.spike).toBe(1.25)
    expect(DOODLE_DEFAULTS.coverage).toBe(1.1)
    expect(DOODLE_DEFAULTS.threshold).toBe(0.18)
    expect(DOODLE_DEFAULTS.multiView).toBe(true)
    expect(DOODLE_DEFAULTS.autoFallback).toBe(true)
  })
})
