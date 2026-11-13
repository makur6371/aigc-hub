import type { ExecutionNode, ExecutionConnection } from '@/lib/canvas-executor'
import type { ToolSlot } from '@/lib/tool-slots'
import { SIZE_TABLE } from '@/lib/image-sizes'
import { resolveVideoSize } from '@/lib/video-capabilities'

/** 单份执行计划 */
export interface ToolRun {
  nodes: ExecutionNode[]
  connections: ExecutionConnection[]
  executeNodeIds: string[]
  label: string
}

/**
 * 比例 + 档位 → 像素尺寸。
 *
 * **直接查标准尺寸表**（image-sizes 的 SIZE_TABLE），这是市面主流做法：
 * OpenAI 官方图片 API 的 size 也只接受固定几组值，不存在「任意比例任意像素」。
 *
 * 之前这里用「面积法」现算（让总面积 ≈ 档位基准²），会得到非标准值：
 * 3:4·1K 算出 888x1184，而标准值是 768x1024 —— 前端下拉显示 768x1024、
 * 实际却发 888x1184，adapter 反查时还匹配不上。
 *
 * 供应商若与标准表不同（如创艺坊的 16:9 是 1920x1088），由**该供应商的 adapter** 覆盖，
 * 全局保持中立、不掺任何一家的规则。
 */
export function resolveSize(ratio: string, tier: string): { width: number; height: number } {
  const std = SIZE_TABLE[ratio]?.[tier]
  if (std) {
    const [w, h] = std.split('x').map(Number)
    if (w && h) return { width: w, height: h }
  }
  // 兜底：标准表没有该组合（理论上不会发生）→ 按 1:1 的档位基准给正方形
  const base = Number(SIZE_TABLE['1:1']?.[tier]?.split('x')[0]) || 1024
  return { width: base, height: base }
}

/**
 * 展开逻辑（设计文档 §4/§5）：
 * - 无风格组：整图跑一遍
 * - 风格组选 N 个：N 份，每份只保留「选中变体 + 其下游子图」；上游共享节点（上传/文本口）由 seedOutputs 复用
 * - 上传/文字口等面板值写入对应节点 inputs
 */
export function buildRuns(
  nodes: ExecutionNode[],
  connections: ExecutionConnection[],
  slots: ToolSlot[],
  values: Record<string, unknown>,
): ToolRun[] {
  const choiceSlots = slots.filter((s) => s.type === 'choice')
  const allVariantIds = new Set(choiceSlots.flatMap((s) => (s.options ?? []).map((o) => o.nodeId)))

  // 每组的选中项（未选且必填 → 默认第一个）
  const groupSelections: { slot: ToolSlot; ids: string[] }[] = []
  for (const slot of choiceSlots) {
    const sel = values[slot.id]
    const picked = (Array.isArray(sel) ? sel : sel ? [sel] : []).map(String)
    const ids = (slot.options ?? []).filter((o) => picked.includes(o.nodeId)).map((o) => o.nodeId)
    if (ids.length === 0 && slot.required !== false && (slot.options?.length ?? 0) > 0) {
      ids.push(slot.options![0].nodeId)
    }
    groupSelections.push({ slot, ids })
  }

  const choiceIds: string[][] = groupSelections.map((g) => g.ids)

  // 多图上传不再按张展开：上传的整组图片作为数组整体传给下游（方案 C）。
  // 展开份数只由风格组选中数决定；多图口是「一次传多张素材」，不是「跑 N 遍」。
  const N = Math.max(1, ...choiceIds.map((ids) => ids.length)) || 1

  const downstream = (nodeId: string): Set<string> => {
    const seen = new Set<string>([nodeId])
    const stack = [nodeId]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of connections) {
        if (c.sourceNodeId === cur && !seen.has(c.targetNodeId)) {
          seen.add(c.targetNodeId)
          stack.push(c.targetNodeId)
        }
      }
    }
    return seen
  }

  /**
   * 非变体上游：沿连线向上收集所有输入源，但**不穿过未选中的变体**。
   *
   * 为什么需要：变体分支的下游节点往往还有别的共享输入（最典型的是「上传的参考图」）。
   * 只取变体自身的 upstream 会漏掉这些共享输入：
   *   上传图 → [AI分支 / 直出分支] → 合并 → 生图
   * 选「直出」时，上传图既不是直出节点的上游，也不是直出分支的下游，
   * 于是不会进执行集，生图节点拿不到参考图。
   * 这里对下游节点也做一次上游遍历，并跳过未选中的变体（防止把另一条分支带回来）。
   */
  const upstreamNonVariant = (nodeId: string, selectedVariantId: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [nodeId]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of connections) {
        if (c.targetNodeId !== cur) continue
        const parent = c.sourceNodeId
        if (seen.has(parent)) continue
        if (allVariantIds.has(parent) && parent !== selectedVariantId) continue
        seen.add(parent)
        stack.push(parent)
      }
    }
    return seen
  }

  const cloneAndApply = (): ExecutionNode[] => {
    const cloned: ExecutionNode[] = JSON.parse(JSON.stringify(nodes))
    for (const slot of slots) {
      if (slot.type === 'choice' || slot.type === 'result') continue
      /**
       * ⚠️ 视频比例槽的「显示值 ≠ 提交值」坑（2026-10-20 修）
       *
       * 前端把 `16:9` 画成**已选中**（`on = (curRatio ?? '16:9') === r`），
       * 但那只是兜底的**显示**默认值 —— 用户如果没真的点一下按钮，
       * `values[ratioSlotId]` 就是 undefined，一个字段都不会写进节点。
       * 于是节点里预埋的尺寸（例如 768×1344 竖屏）原样生效，
       * 用户明明「看到」选的是 16:9，出来却是竖屏。
       *
       * 治理原则：**面板显示什么，就必须提交什么**。
       * 这里对视频比例槽在「未提交」时用 slot.defaultRatio 兜底，
       * 分辨率/时长优先取节点已有的值，没有再用模型档位默认。
       * 只对视频生效（图片的 ratio 槽另有 tier 体系，避免误伤既有行为）。
       */
      const isVideoRatioSlot = slot.type === 'ratio'
        && slot.targets.some((t) => t.port === 'aspectRatio')
      let v = values[slot.id]
      if (isVideoRatioSlot && (v === undefined || v === null || v === '')) {
        const seedNode = nodes.find((n) => n.id === slot.targets[0]?.nodeId)
        v = {
          ratio: slot.defaultRatio ?? '16:9',
          resolution: seedNode?.inputs?.resolution,
          duration: seedNode?.inputs?.duration,
        }
      }
      if (v === undefined || v === null || v === '') continue
      for (const t of slot.targets) {
        const node = cloned.find((n) => n.id === t.nodeId)
        if (!node) continue
        node.inputs = { ...(node.inputs ?? {}) }
        // ratio 档位：面板传 {ratio:'1:1', tier:'2K'} → width/height；视频传 aspectRatio 字符串
        if (slot.type === 'ratio' && typeof v === 'object' && v !== null && 'ratio' in v) {
          const vv = v as { ratio?: string; tier?: string; resolution?: string; duration?: number }
          if (t.port === 'aspectRatio') {
            node.inputs[t.port] = vv.ratio
          } else if (t.port === 'duration') {
            // 视频时长：面板选的秒数直接写入节点
            if (vv.duration != null) node.inputs[t.port] = vv.duration
          } else if (t.port === 'resolution') {
            // 视频清晰度档：单独写入节点（上游按枚举档生成/计费），与像素并存
            if (vv.resolution != null && vv.resolution !== '') node.inputs[t.port] = vv.resolution
          } else if (t.port === 'width' || t.port === 'height') {
            // 视频：比例 + 分辨率档 → 像素（如 16:9 + 720p → 1280x720）；
            // 档位缺省时按 tier 走图片标准表；两者都解析不出则忽略（交给节点默认）。
            const videoSize = vv.resolution ? resolveVideoSize(vv.ratio ?? '16:9', vv.resolution) : null
            if (videoSize) {
              node.inputs[t.port] = t.port === 'width' ? videoSize.width : videoSize.height
            } else {
              const size = resolveSize(vv.ratio ?? '1:1', vv.tier ?? '1K')
              node.inputs[t.port] = t.port === 'width' ? size.width : size.height
            }
          } else {
            // 查标准尺寸表（与前端下拉同源），保证「显示什么就发什么」。
            // 与标准表不同的供应商由各自的 adapter 覆盖。
            const size = resolveSize(vv.ratio ?? '1:1', vv.tier ?? '1K')
            node.inputs[t.port] = t.port === 'width' ? size.width : size.height
          }
        } else {
          node.inputs[t.port] = v
        }
      }
    }
    return cloned
  }

  const runs: ToolRun[] = []
  for (let i = 0; i < N; i++) {
    const cloned = cloneAndApply()
    // 本份每组选中的风格：第 i 个（循环复用）；单选组恒走唯一选中项
    const stylePerGroup = groupSelections.map((g) => ({
      slot: g.slot,
      styleId: g.ids.length > 0 ? (g.slot.single ? g.ids[0] : g.ids[i % g.ids.length]) : undefined,
    }))
    const activeStyles = stylePerGroup.filter((g) => g.styleId)
    const labelParts: string[] = activeStyles.map((g) =>
      (g.slot.options ?? []).find((o) => o.nodeId === g.styleId)?.label ?? '')

    if (activeStyles.length === 0) {
      // 无风格组：跑全图
      runs.push({
        nodes: cloned,
        connections,
        executeNodeIds: cloned.map((n) => n.id),
        label: labelParts.join(' · '),
      })
      continue
    }
    // 每组剪枝：执行集 =「选中变体 + 其下游」；未选变体的下游不跑（prompt 空会报错）。
    // 保留集（nodes/connections）比执行集大：非变体上游（上传/文本口）作为输入源透传
    const exec = new Set<string>()
    for (const g of activeStyles) {
      const selectedId = g.styleId!
      const down = downstream(selectedId)
      for (const id of down) exec.add(id)
      // 变体之前的上游链也要跑（上传/裁切等），否则下游拿不到输入
      for (const id of upstreamNonVariant(selectedId, selectedId)) exec.add(id)
      // 下游节点自己的共享输入（如参考图上传）也要跑 —— 它们不在变体上游里
      for (const id of down) {
        for (const up of upstreamNonVariant(id, selectedId)) exec.add(up)
      }
    }
    const keep = new Set([...exec, ...cloned.filter((n) => !allVariantIds.has(n.id)).map((n) => n.id)])
    const keptNodes = cloned.filter((n) => keep.has(n.id))
    const keptIds = new Set(keptNodes.map((n) => n.id))
    runs.push({
      nodes: keptNodes,
      connections: connections.filter((c) => keptIds.has(c.sourceNodeId) && keptIds.has(c.targetNodeId)),
      executeNodeIds: cloned.filter((n) => exec.has(n.id)).map((n) => n.id),
      label: labelParts.join(' · '),
    })
  }
  return runs
}

/** 相邻份之间共享的素材/文本节点（非生成类、有产出的），下一份用 seedOutputs 跳过重跑 */
export function runSharedOutputs(
  run: ToolRun,
): Record<string, Record<string, unknown>> {
  // runCanvasGraph 的 done 事件带全量 outputs，但这里拿不到内部值——
  // 简化：共享上传节点的输出=其 inputs（透传），直接从 inputs 构造 seed
  const seed: Record<string, Record<string, unknown>> = {}
  for (const n of run.nodes) {
    if (n.type === 'image-upload' && n.inputs?.image) {
      // 多图口：inputs.image 可能是数组，按 batch 语义播种。
      // 产出形状必须与 executeNode('image-upload') 完全一致（{images, imageUrl, count}）：
      // 连线声明的源口可能是 imageUrl 也可能是 image，只给 images 会让其中一种连线取不到值，
      // 下游就会「收不到参考图」（上游报「请上传产品参考图」）。
      if (Array.isArray(n.inputs.image)) {
        seed[n.id] = { images: n.inputs.image, imageUrl: n.inputs.image, count: n.inputs.image.length }
      } else {
        seed[n.id] = { imageUrl: n.inputs.image }
      }
    } else if (n.type === 'image-upload-batch' && Array.isArray(n.inputs?.images)) {
      seed[n.id] = { images: n.inputs.images, count: (n.inputs.images as unknown[]).length }
    } else if (n.type === 'audio-upload' && n.inputs?.audio) {
      seed[n.id] = { audio: n.inputs.audio }
    } else if (n.type === 'text-input' && n.inputs?.content != null) {
      seed[n.id] = { text: n.inputs.content }
    }
  }
  return seed
}

export interface SharedWorkPlan {
  /** 需要「预跑一次」的共享节点（多份工具才有） */
  sharedExecIds: string[]
  /** 直接播种、无需执行的透传节点产出 */
  passthroughSeed: Record<string, Record<string, unknown>>
  /** 全局已处理节点：各份执行集里要剔除的集合 */
  globallyHandled: Set<string>
}

/**
 * 规划「跨份共享」的工作，避免同一节点在 N 份里重复执行（重复调用上游 / 重复扣费 / 重复落盘）。
 *
 * 关键约束：**只有确实被全局处理过的节点才能从各份执行集里剔除**。
 * 早先的实现按「不在风格组里 = 共享」一刀切剔除，导致「无风格组」的工具
 * （文生图 / 图生图 / 九宫格模式1）所有节点都被剔除 → 执行集为空 → 一张图都不出，
 * 成果区全部显示「生成失败或链接失效」。
 */
export function planSharedWork(
  runs: ToolRun[],
  slots: ToolSlot[],
  connections: ExecutionConnection[],
): SharedWorkPlan {
  const passthroughSeed = runs.length > 0 ? runSharedOutputs(runs[0]) : {}
  // 单份工具没有可复用的东西：保持一次整图执行（与并发重构前行为一致）
  if (runs.length <= 1) {
    return { sharedExecIds: [], passthroughSeed, globallyHandled: new Set() }
  }

  const variantIds = new Set(slots.filter((s) => s.type === 'choice').flatMap((s) => (s.options ?? []).map((o) => o.nodeId)))

  // 依赖风格变体的节点（变体的下游闭包）：必须留在各份里跑，预跑阶段拿不到变体产出
  const variantDependent = new Set<string>()
  {
    const stack = [...variantIds]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of connections) {
        if (c.sourceNodeId === cur && !variantDependent.has(c.targetNodeId)) {
          variantDependent.add(c.targetNodeId)
          stack.push(c.targetNodeId)
        }
      }
    }
  }

  // 「每份子图都有、且不属于任何风格变体」的节点
  const sharedIds = new Set(
    runs[0].nodes
      .filter((n) => !variantIds.has(n.id) && runs.every((r) => r.nodes.some((x) => x.id === n.id)))
      .map((n) => n.id),
  )

  // 预跑集 = 共享节点 − 纯透传节点（由 seed 播种）− 依赖变体的节点
  const sharedExecIds = runs[0].nodes
    .filter((n) => sharedIds.has(n.id) && !(n.id in passthroughSeed) && !variantDependent.has(n.id))
    .map((n) => n.id)

  return {
    sharedExecIds,
    passthroughSeed,
    globallyHandled: new Set<string>([...sharedExecIds, ...Object.keys(passthroughSeed)]),
  }
}
