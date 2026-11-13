import { getPrisma } from '@/lib/prisma'
import { buildRuns, type ToolRun } from '@/lib/tool-run-plan'
import { planNodeCharge, nodeChargeInputs } from '@/lib/billing/billing-plans'
import type { ExecutionNode, ExecutionConnection } from '@/lib/canvas-executor'
import { estimatePaidCharge } from '@/lib/free-quota'
import { checkFreeImagePass } from '@/lib/promotions/free-image-pass'
import { resolveChargeModel } from '@/lib/model-catalog'
import {
  reconcileParamSlots,
  type ToolSlot,
  type ToolNodeSnapshot,
  type ToolConnectionSnapshot,
} from '@/lib/tool-slots'

// ===== 工具运行：解析与计费（run / estimate 共用） =====
// 放在 lib 而非 route.ts：Next.js 的 route 文件只允许导出 HTTP 方法与路由配置，
// 导出普通函数会导致「does not match the required types of a Next.js Route」构建失败。

/** 解析工具 + 参数槽 + 展开执行计划（run 与 estimate 共用的前置） */
export async function resolveToolRuns(id: string, values: Record<string, unknown>) {
  const prisma = await getPrisma()
  const tool = await prisma.tool.findFirst({ where: { OR: [{ id }, { slug: id }] } })
  if (!tool || tool.status !== 'APPROVED') return { error: '工具不存在或未上架' as const }
  const wf = tool.workflow as unknown as { nodes: ExecutionNode[]; connections: ExecutionConnection[] }
  const slots = reconcileParamSlots(
    wf.nodes as unknown as ToolNodeSnapshot[],
    wf.connections as unknown as ToolConnectionSnapshot[],
    (tool.slots as unknown as ToolSlot[]) ?? [],
  )
  const runs = buildRuns(wf.nodes, wf.connections, slots, values)
  return { tool, wf, slots, runs }
}

/**
 * 计算一次工具运行的确切积分/豆消耗（含每日免费额度抵扣）。
 *
 * run（真实执行）与 estimate（「开始生成」旁的预估）共用同一实现，
 * 保证「显示多少就扣多少」，不会出现两处口径漂移。
 */
export async function computeRunCharge(
  runs: ToolRun[],
  slots: ToolSlot[],
  userId: string,
): Promise<{ totalCost: number; totalBeans: number }> {
  const prisma = await getPrisma()
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { freeImageUntil: true } })
  const chargeItems: Array<{ model: { id: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null }; points: number; beans: number }> = []
  // 共享节点（上传/裁切/共享 LLM）在每份子图里都有，但实际只跑一次 → 只计一次，
  // 否则 N 份会把同一笔成本算 N 遍，积分刚好够用时会被误判为「不足」。
  const countedSharedNodes = new Set<string>()
  const variantNodeIds = new Set(slots.filter((s) => s.type === 'choice').flatMap((s) => (s.options ?? []).map((o) => o.nodeId)))
  for (const run of runs) {
    for (const node of run.nodes) {
      const isShared = !variantNodeIds.has(node.id)
      if (isShared) {
        if (countedSharedNodes.has(node.id)) continue
        countedSharedNodes.add(node.id)
      }
      if (node.type === 'llm-chat' || node.type === 'image-generate' || node.type === 'nine-grid-loop' || node.type === 'video-generate') {
        const type = node.type === 'video-generate' ? 'VIDEO' : (node.type === 'image-generate' || node.type === 'nine-grid-loop') ? 'IMAGE' : 'TEXT'
        const modelId = node.inputs?.model ? String(node.inputs.model) : undefined
        // 与执行期同口径：指定模型失效时按类型回退到「已配 Key 且支持该能力」的模型
        const model = await resolveChargeModel(type, modelId)
        if (!model) continue
        if ((await checkFreeImagePass({ id: model.id, type, dailyUserFreeQuota: model.dailyUserFreeQuota }, user ?? {}, userId)).free) continue
        const meta = (model.metadata as Record<string, unknown> | null) ?? null
        // 计费因子统一走 nodeChargeInputs：预估必须与实扣同口径，否则「显示多少就扣多少」失效
        const charge = planNodeCharge(
          type,
          { costPoints: model.costPoints, videoCost: model.videoCost, discount: model.discount, isFree: model.isFree, metadata: meta },
          nodeChargeInputs(node.inputs),
        )
        chargeItems.push({
          model: { id: model.id, dailyUserFreeQuota: model.dailyUserFreeQuota, dailyPlatformFreeQuota: model.dailyPlatformFreeQuota },
          points: charge.points,
          beans: charge.beans,
        })
      }
    }
  }
  const { points, beans } = await estimatePaidCharge(chargeItems, userId)
  return { totalCost: points, totalBeans: beans }
}
