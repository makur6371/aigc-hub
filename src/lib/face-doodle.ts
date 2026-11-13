// ===== 人脸智能涂鸦（漫剧过脸）算法核心 =====
//
// 从外部 Face FX Studio 工具**提取重写**的算法（非照抄）：对四视图/分镜稿/照片
// 做人脸检测，在每张脸上生成「细长乱划涂鸦」——遮挡面部但透气（纵向往复刮擦线
// 保留五官轮廓感），用于漫剧合规的过脸处理。
//
// 本模块**零 DOM 依赖**：绘制函数只要求调用方传入 CanvasRenderingContext2D
// （或任何实现 stroke/bezierCurveTo 的 2D 上下文），检测/NMS/网格推断均为纯函数，
// 可在 Node 单测；MediaPipe 的调用放在工作台组件（浏览器端）。

// ---------- 类型 ----------

/** 一个涂鸦框（原始像素坐标），isFallback=检测缺失时按列推算的兜底框，isManual=手动框选 */
export interface DoodleBox {
  x: number
  y: number
  w: number
  h: number
  score?: number
  isFallback?: boolean
  isManual?: boolean
}

/** 一次原始检测（MediaPipe boundingBox 归一化形态） */
export interface RawDetection {
  /** 中心点，0~1（相对被检图） */
  xCenter: number
  yCenter: number
  /** 宽高，0~1（相对被检图） */
  width: number
  height: number
  score: number
}

/** 涂鸦绘制参数 */
export interface ScribbleParams {
  /** 笔数（线条密集度） */
  density: number
  /** 基准笔画粗细（px，按脸宽 180 自适应缩放） */
  strokeWidth: number
  /** 上下飞白溢出系数（1=不溢出，>1 向上下冲出框外） */
  spike: number
  /** 遮挡范围缩放倍率（涂鸦框相对检测框的放大） */
  coverage: number
}

// ---------- 参数枚举（节点面板下拉的取值表） ----------

export const DOODLE_DENSITY_OPTIONS = [15, 30, 42, 60, 90]
export const DOODLE_STROKE_WIDTH_OPTIONS = [1.0, 1.5, 2.2, 3.5, 5.0]
export const DOODLE_SPIKE_OPTIONS = [
  { value: 1.0, label: '收束 (1.0)' },
  { value: 1.25, label: '自然 (1.25)' },
  { value: 1.45, label: '强溢出 (1.45)' },
]
export const DOODLE_COVERAGE_OPTIONS = [
  { value: 0.9, label: '贴合 (0.9x)' },
  { value: 1.1, label: '微扩 (1.1x)' },
  { value: 1.3, label: '放宽 (1.3x)' },
]
export const DOODLE_THRESHOLD_OPTIONS = [
  { value: 0.08, label: '高灵敏 (0.08，线稿/侧脸)' },
  { value: 0.18, label: '均衡 (0.18)' },
  { value: 0.3, label: '保守 (0.30，仅正脸)' },
]

export const DOODLE_DEFAULTS = {
  density: 42,
  strokeWidth: 2.2,
  spike: 1.25,
  coverage: 1.1,
  multiView: true,
  threshold: 0.18,
  autoFallback: true,
} as const

// ---------- 1. 四视图切片网格推断 ----------

/**
 * 按图片形态推断检测网格：四视图横条/竖条/大图分镜各用不同密度，
 * 切片检测比整图检测对小脸/侧脸灵敏得多。
 */
export function inferSliceGrid(w: number, h: number): { cols: number; rows: number } {
  const aspect = w / h
  if (aspect >= 1.8) return { cols: aspect >= 3.2 ? 5 : 4, rows: 1 } // 四视图/五视图横条
  if (aspect <= 0.6) return { cols: 1, rows: 4 } // 竖条分镜
  if (w >= 1600 || h >= 1600) return { cols: 3, rows: 2 } // 大图 2x3 分镜
  return { cols: 2, rows: 2 }
}

// ---------- 2. 检测结果归并与兜底 ----------

/** 把归一化检测框换算为原图像素框 */
export function normalizeBox(det: RawDetection, offsetX: number, offsetY: number, tileW: number, tileH: number): DoodleBox {
  const w = det.width * tileW
  const h = det.height * tileH
  return {
    x: offsetX + (det.xCenter * tileW - w / 2),
    y: offsetY + (det.yCenter * tileH - h / 2),
    w,
    h,
    score: det.score,
  }
}

/** IoU 阈值 NMS：全图 + 切片多轮检测的重复框只留最高分 */
export function suppressDuplicates(boxes: DoodleBox, threshold?: number): never
export function suppressDuplicates(boxes: DoodleBox[], threshold?: number): DoodleBox[]
export function suppressDuplicates(boxes: DoodleBox[] | DoodleBox, threshold = 0.35): DoodleBox[] {
  const list = Array.isArray(boxes) ? boxes : [boxes]
  const sorted = [...list].sort((a, b) => (b.score ?? 0.8) - (a.score ?? 0.8))
  const kept: DoodleBox[] = []
  for (const cand of sorted) {
    let duplicated = false
    for (const best of kept) {
      const x1 = Math.max(cand.x, best.x)
      const y1 = Math.max(cand.y, best.y)
      const x2 = Math.min(cand.x + cand.w, best.x + best.w)
      const y2 = Math.min(cand.y + cand.h, best.y + best.h)
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
      const union = cand.w * cand.h + best.w * best.h - inter
      if (union > 0 && inter / union > threshold) { duplicated = true; break }
    }
    if (!duplicated) kept.push(cand)
  }
  return kept
}

/**
 * 背影兜底：横长多视图里检出的脸数 < 列数时，缺失列按平均框大小/基线高度
 * 推一个兜底框（画上涂鸦，宁可多涂不可漏涂——漫剧过脸是合规硬要求）。
 */
export function inferMissingViews(faces: DoodleBox[], imgW: number, cols: number): DoodleBox[] {
  if (faces.length === 0 || faces.length >= cols) return faces
  const avgW = faces.reduce((s, f) => s + f.w, 0) / faces.length
  const avgH = faces.reduce((s, f) => s + f.h, 0) / faces.length
  const baseY = faces.reduce((s, f) => s + f.y, 0) / faces.length
  const colWidth = imgW / cols
  const occupied = new Set(faces.map((f) => Math.floor((f.x + f.w / 2) / colWidth)))
  const out = [...faces]
  for (let c = 0; c < cols; c++) {
    if (!occupied.has(c)) {
      out.push({ x: c * colWidth + (colWidth - avgW) / 2, y: baseY, w: avgW, h: avgH, isFallback: true })
    }
  }
  return out
}

/** 手动小框扩展：点一下（拖拽 <15 显示像素）自动变成默认脸框 */
export function expandTinyBox(sx: number, sy: number, ex: number, ey: number, imgW: number, minPx = 15): DoodleBox {
  const w = Math.abs(ex - sx)
  const h = Math.abs(ey - sy)
  const x = Math.min(sx, ex)
  const y = Math.min(sy, ey)
  if (w >= minPx || h >= minPx) return { x, y, w, h, isManual: true }
  const defW = Math.max(80, imgW * 0.09)
  return { x: x - defW / 2, y: y - defW * 1.25 / 2, w: defW, h: defW * 1.25, isManual: true }
}

// ---------- 3. 确定性伪随机（同图同参数 → 同涂鸦，重跑可复现） ----------

/** sin 驱动的种子随机：与原工具一致的确定性，保证预览/导出/重跑涂鸦纹理稳定 */
export function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

// ---------- 4. 乱划涂鸦绘制 ----------

/**
 * 在一个框内画「原图同款细长乱划」：
 *  - 主线：纵向往复刮擦 N 笔（贝塞尔，跨度大不堆积，保留透气感）
 *  - 飞白：每笔向上下过冲（spike 系数），形成毛刺
 *  - 死结：低频回旋小结（约每 7 笔一个）
 *  - 贯穿斜线：少量（2~4 笔）长斜线增加肆意感
 *
 * ctx 由调用方传入（浏览器 Canvas 2D）；坐标全部是原始像素。
 */
export function drawScribbleFace(
  c: { strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; beginPath: () => void; moveTo: (x: number, y: number) => void; bezierCurveTo: (a: number, b: number, cx2: number, cy2: number, x: number, y: number) => void; lineTo: (x: number, y: number) => void; stroke: () => void; save: () => void; restore: () => void },
  box: DoodleBox,
  params: ScribbleParams,
  seed: number,
): void {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2

  const drawW = box.w * params.coverage
  const drawH = box.h * params.spike * params.coverage
  const ox = cx - drawW / 2
  const oy = cy - drawH * 0.48

  c.save()
  c.strokeStyle = '#080808'
  c.lineWidth = Math.max(1.5, (box.w / 180) * params.strokeWidth)
  c.lineCap = 'round'
  c.lineJoin = 'round'

  const n = Math.max(3, Math.round(params.density))

  // 主线：纵向往复刮擦
  c.beginPath()
  let curX = ox + 0.06 * drawW
  let curY = oy + 0.5 * drawH
  c.moveTo(curX, curY)
  for (let i = 0; i < n; i++) {
    const progress = i / n
    const goingDown = i % 2 === 1
    // 飞白过冲：目标端点冲出上下边
    const overshoot = (seededRandom(seed + i * 2.1) - 0.5) * 0.22
    const targetY = oy + (goingDown ? 0.96 + overshoot : 0.04 - overshoot) * drawH
    // 横向步进 + 抖动（大跨度，避免紧密堆积）
    const jitter = (seededRandom(seed + i * 3.7) - 0.5) * 0.18
    const targetX = ox + (0.06 + progress * 0.88 + jitter) * drawW
    // 柔和弧度控制点
    const cpY = oy + (goingDown ? 0.38 : 0.62) * drawH + (seededRandom(seed + i * 7.1) - 0.5) * 0.25 * drawH
    const cpX = curX + (seededRandom(seed + i * 5.3) - 0.5) * 0.26 * drawW
    c.bezierCurveTo(cpX, cpY, targetX, cpY, targetX, targetY)
    // 偶发回旋死结
    if (i % 7 === 0 && i > 0) {
      const r = (0.04 + seededRandom(seed + i * 9.3) * 0.04) * drawW
      c.bezierCurveTo(targetX - r, targetY, targetX - r, oy + 0.5 * drawH, targetX, oy + 0.5 * drawH)
    }
    curX = targetX
    curY = targetY
  }
  c.stroke()

  // 贯穿长斜线（2~4 笔）
  c.beginPath()
  c.lineWidth = Math.max(1.5, (box.w / 180) * params.strokeWidth) * 0.9
  const slashes = Math.min(4, Math.max(2, Math.floor(n * 0.08)))
  for (let j = 0; j < slashes; j++) {
    const sx = ox + (0.12 + seededRandom(seed + j * 11) * 0.76) * drawW
    const sy = oy + (0.06 + (j % 2) * 0.08) * drawH
    const ex = ox + (0.12 + seededRandom(seed + j * 13) * 0.76) * drawW
    const ey = oy + (0.94 - (j % 2) * 0.08) * drawH
    c.moveTo(sx, sy)
    c.lineTo(ex, ey)
  }
  c.stroke()

  c.restore()
}

/** 整图绘制：对每个框依次涂鸦（种子按框序号错开，各框纹理不同但确定） */
export function drawScribbleAll(
  ctx: Parameters<typeof drawScribbleFace>[0],
  boxes: DoodleBox[],
  params: ScribbleParams,
  baseSeed = 88,
): void {
  boxes.forEach((box, idx) => drawScribbleFace(ctx, box, params, baseSeed + idx * 433))
}
