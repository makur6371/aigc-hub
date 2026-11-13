// 生图尺寸对照表：比例 × 分辨率档位 → 像素尺寸（与主流生图 API 对齐）
export const ASPECT_RATIOS = [
  '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5',
  '16:9', '9:16', '2:1', '1:2', '21:9', '9:21',
  // 放在末尾有两个原因：① 不影响各处 `ASPECT_RATIOS.slice(0, 8)` 的「常用比例」兜底；
  // ② 是否对用户开放仍由模型 metadata.sizes 决定 —— 这里只是让它们可被配置、可被 decodeSize 反查。
  '4:1', '1:4', '8:1', '1:8',
] as const

export const RES_TIERS = ['1K', '2K', '4K'] as const

// SIZE_TABLE[aspect][tier] = "宽x高"
export const SIZE_TABLE: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2048x1360', '4K': '3520x2336' },
  '2:3': { '1K': '1024x1536', '2K': '1360x2048', '4K': '2336x3520' },
  '4:3': { '1K': '1024x768', '2K': '2048x1536', '4K': '3312x2480' },
  '3:4': { '1K': '768x1024', '2K': '1536x2048', '4K': '2480x3312' },
  '5:4': { '1K': '1280x1024', '2K': '2560x2048', '4K': '3216x2576' },
  '4:5': { '1K': '1024x1280', '2K': '2048x2560', '4K': '2576x3216' },
  '16:9': { '1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '864x1536', '2K': '1152x2048', '4K': '2160x3840' },
  '2:1': { '1K': '2048x1024', '2K': '2688x1344', '4K': '3840x1920' },
  '1:2': { '1K': '1024x2048', '2K': '1344x2688', '4K': '1920x3840' },
  '21:9': { '1K': '2016x864', '2K': '2688x1152', '4K': '3840x1648' },
  '9:21': { '1K': '864x2016', '2K': '1152x2688', '4K': '1648x3840' },
  // 极端比例按「面积基准边」给出像素（sqrt(w*h) ≈ 1024/2048/2880），保证：
  //   · decodeSize 能精确反查出比例+档位（档位差价计费不失效）
  //   · adapter __toTier 的按面积吸附能回到同一个档位（不会被降档/升档）
  '4:1': { '1K': '2048x512', '2K': '4096x1024', '4K': '5760x1440' },
  '1:4': { '1K': '512x2048', '2K': '1024x4096', '4K': '1440x5760' },
  '8:1': { '1K': '2880x360', '2K': '5760x720', '4K': '8160x1020' },
  '1:8': { '1K': '360x2880', '2K': '720x5760', '4K': '1020x8160' },
}

// metadata.sizes 的编码格式："16:9@1K"（比例@档位），执行时查表还原像素；
// 兼容旧格式 "宽x高"（直传像素）
export function encodeSize(ratio: string, tier: string): string {
  return `${ratio}@${tier}`
}

export function decodeSize(encoded: string): { ratio: string; tier: string; width: number; height: number } | null {
  const at = encoded.indexOf('@')
  if (at > 0) {
    const ratio = encoded.slice(0, at)
    const tier = encoded.slice(at + 1)
    const wh = SIZE_TABLE[ratio]?.[tier]
    if (!wh) return null
    const [width, height] = wh.split('x').map(Number)
    return { ratio, tier, width, height }
  }
  // 旧格式 "宽x高"：反查比例/档位
  const [w, h] = encoded.split('x').map(Number)
  if (!w || !h) return null
  for (const ratio of ASPECT_RATIOS) {
    for (const tier of RES_TIERS) {
      const wh = SIZE_TABLE[ratio][tier]
      const [tw, th] = wh.split('x').map(Number)
      if (tw === w && th === h) return { ratio, tier, width: w, height: h }
    }
  }
  return { ratio: `${w}:${h}`, tier: '', width: w, height: h }
}

export interface DecodedImageSize {
  ratio: string
  tier: string
  width: number
  height: number
}

export interface ImageCapabilities {
  /** 模型是否显式声明了 metadata.sizes；声明后不得再回落到全局档位 */
  declared: boolean
  sizes: DecodedImageSize[]
  ratios: string[]
  tiers: string[]
  tiersByRatio: Record<string, string[]>
}

interface ImageModelLike {
  metadata?: Record<string, unknown> | null
}

/**
 * 图片模型能力的唯一读取口径。
 *
 * 画布、工具箱、Agent 偏好、Planner 与执行层都必须从这里读 metadata.sizes，
 * 不要各自 split('@')。旧数据里的 "1536x1024" 也必须通过 decodeSize 反查，
 * 否则同一模型会在画布显示 3:2、在 Agent 里显示 1536:1024。
 */
export function getImageCapabilities(model: ImageModelLike | undefined | null): ImageCapabilities {
  const meta = (model?.metadata ?? {}) as Record<string, unknown>
  const raw = Array.isArray(meta.sizes)
    ? (meta.sizes as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []
  const sizes = raw
    .map((entry) => decodeSize(entry))
    .filter((d): d is DecodedImageSize => !!d)

  const ratios: string[] = []
  const tiers: string[] = []
  const tiersByRatio: Record<string, string[]> = {}
  for (const d of sizes) {
    if (!ratios.includes(d.ratio)) ratios.push(d.ratio)
    if (d.tier && !tiers.includes(d.tier)) tiers.push(d.tier)
    if (d.tier) {
      const list = tiersByRatio[d.ratio] ?? (tiersByRatio[d.ratio] = [])
      if (!list.includes(d.tier)) list.push(d.tier)
    }
  }

  return { declared: raw.length > 0, sizes, ratios, tiers, tiersByRatio }
}

/** 按比例+档位找合法规格；只给比例时返回该比例的首个档位。 */
export function findImageSize(
  cap: ImageCapabilities,
  ratio?: string | null,
  tier?: string | null,
): DecodedImageSize | undefined {
  if (ratio && tier) {
    return cap.sizes.find((d) => d.ratio === ratio && d.tier === tier.toUpperCase())
  }
  if (ratio) return cap.sizes.find((d) => d.ratio === ratio)
  return cap.sizes[0]
}

/** 图片规格是否存在（模型未声明时返回 true，由全局兜底决定）。 */
export function supportsImageSize(
  cap: ImageCapabilities,
  ratio?: string | null,
  tier?: string | null,
): boolean {
  if (!cap.declared) return true
  if (!ratio) return false
  if (!tier) return cap.ratios.includes(ratio)
  return cap.sizes.some((d) => d.ratio === ratio && d.tier === tier.toUpperCase())
}

/**
 * 把用户请求的像素尺寸吸附到模型声明的合法规格。
 *
 * 优先级：
 * 1. 精确命中
 * 2. 同比例内面积最接近（保住用户选的比例）
 * 3. 全局面积最接近（比例本身不可用时才退）
 *
 * 计费必须在吸附之后进行，否则「请求 4K、模型只有 1K」会按 4K 预扣。
 */
export function resolveImageSizeForModel(
  metadata: Record<string, unknown> | null | undefined,
  width?: number | null,
  height?: number | null,
): DecodedImageSize | null {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null

  const cap = getImageCapabilities({ metadata: metadata ?? null })
  if (!cap.declared || cap.sizes.length === 0) {
    return decodeSize(`${Math.round(w)}x${Math.round(h)}`)
  }

  const exact = cap.sizes.find((d) => d.width === Math.round(w) && d.height === Math.round(h))
  if (exact) return exact

  const targetArea = w * h
  const targetRatio = w / h
  const closest = (items: DecodedImageSize[]) => {
    let best = items[0]
    let bestDiff = Math.abs(best.width * best.height - targetArea)
    for (const item of items.slice(1)) {
      const diff = Math.abs(item.width * item.height - targetArea)
      if (diff < bestDiff) {
        best = item
        bestDiff = diff
      }
    }
    return best
  }

  const sameRatio = cap.sizes.filter((d) => {
    const ratio = d.width / d.height
    return Math.abs(ratio - targetRatio) / targetRatio <= 0.1
  })
  return closest(sameRatio.length > 0 ? sameRatio : cap.sizes)
}

// 展开勾选的比例×档位 → metadata.sizes 数组
export function expandSizes(ratios: string[], tiers: string[]): string[] {
  const out: string[] = []
  for (const r of ratios) {
    for (const t of tiers) {
      if (SIZE_TABLE[r]?.[t]) out.push(encodeSize(r, t))
    }
  }
  return out
}
