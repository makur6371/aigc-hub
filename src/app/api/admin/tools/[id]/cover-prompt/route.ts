import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError, success } from '@/lib/api-handler'
import { reconcileParamSlots, type ToolSlot, type ToolNodeSnapshot, type ToolConnectionSnapshot } from '@/lib/tool-slots'
import { deriveCoverVars, buildCoverPrompt, COVER_STYLE_LABELS } from '@/lib/tool-cover-prompt'

// 按工具自动推导封面提示词：变量全部来自工具快照（槽位 / 节点 / 连线），
// 管理员不用手填 INPUT / WORKFLOW / RESULT，拿到就能直接丢给生图模型。
export const GET = apiHandler<{ id: string }>(async (request: NextRequest, { params }) => {
  await requireAuth(request, { admin: true })
  const { id } = await params
  const prisma = await getPrisma()
  const tool = await prisma.tool.findUnique({ where: { id } })
  if (!tool) throw new ApiHandlerError('工具不存在', 404)

  const wf = tool.workflow as unknown as { nodes: ToolNodeSnapshot[]; connections: ToolConnectionSnapshot[] }
  // 与执行/详情接口同一套槽位口径，避免「管理端看到的输入和实际执行的不一致」
  const slots = reconcileParamSlots(
    wf.nodes ?? [],
    wf.connections ?? [],
    (tool.slots as unknown as ToolSlot[]) ?? [],
  )

  const vars = deriveCoverVars({
    name: tool.name,
    description: tool.description,
    category: tool.category,
    slots,
    nodes: (wf.nodes ?? []).map((n) => ({ id: n.id, type: n.type, label: n.label ?? n.type })),
    connections: (wf.connections ?? []).map((c) => ({ sourceNodeId: c.sourceNodeId, targetNodeId: c.targetNodeId })),
  })

  return success({
    vars,
    styleLabel: COVER_STYLE_LABELS[vars.style],
    prompt: buildCoverPrompt(vars),
  })
})
