// ===== 批量展开的位置计算：前后端唯一实现 =====
//
// 背景（INV-2026-0919-04 的 D-01）：
// 「json-prompt-batch 节点展开为 N 份副本」这件事，前后端各写了一套：
//   - 前端 app/(app)/canvas/page.tsx 的 expandBatchNode（按 estimateNodeHeight 算间距）
//   - 后端 lib/mcp/executor.ts 的 expandBatchCopies（硬编码 +120）
// 两者已经漂移：同一个 N，前端算出的副本位置与后端不同 →
// 前端在「后端展开」后再本地展开时，副本会重叠或错位。
//
// 本模块把**位置计算**抽出来，前后端共用同一套公式，杜绝再次漂移。
// 注意：这里只管坐标，不管副本的 id / 连线 —— 那些由调用方各自生成
// （前端要 generateId('node')，后端要 genNodeId()，两者 ID 体系不同）。

/** 副本在「主本」右下方逐份排开所需的布局参数 */
export interface BatchLayout {
  /** 第 1 份副本相对主本的 x 偏移 */
  offsetX: number
  /** 每份副本额外增加的 x 偏移（形成斜向排列） */
  stepX: number
  /** 每份副本增加的 y 偏移（= 节点高度 + 垂直间距） */
  stepY: number
}

/**
 * 计算副本坐标。
 *
 * 公式（与前端既有实现保持一致，避免改变用户已习惯的视觉效果）：
 *   x(i) = baseX + offsetX + i * stepX
 *   y(i) = baseY + i * stepY
 *
 * @param base 主本坐标
 * @param index 副本序号（从 1 开始；0 是主本）
 * @param layout 布局参数（由调用方按节点真实高度算 stepY）
 */
export function batchCopyPosition(
  base: { x: number; y: number },
  index: number,
  layout: BatchLayout,
): { x: number; y: number } {
  return {
    x: base.x + layout.offsetX + index * layout.stepX,
    y: base.y + index * layout.stepY,
  }
}

/** 默认布局参数（用于「拿不到节点高度」的后端场景） */
export const DEFAULT_BATCH_LAYOUT: BatchLayout = {
  offsetX: 48,
  stepX: 16,
  // 后端原本硬编码 120；改为「估算节点高度 + 垂直间距」的默认值，
  // 与前端在典型节点高度下的结果接近。前端会传真实高度覆盖它。
  stepY: 160,
}

/**
 * 由节点高度推算布局参数（前端用：节点高矮不一，按真实高度排不会重叠）。
 *
 * @param nodeHeight 节点渲染高度（estimateNodeHeight 的结果）
 */
export function batchLayoutForHeight(nodeHeight: number): BatchLayout {
  return {
    offsetX: DEFAULT_BATCH_LAYOUT.offsetX,
    stepX: DEFAULT_BATCH_LAYOUT.stepX,
    // 与前端原实现一致：节点高度 + 80 间距
    stepY: Math.max(80, nodeHeight) + 80,
  }
}
