import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { runCanvasGraph } from '@/lib/mcp/executor'
import { planNodeCharge, nodeChargeInputs } from '@/lib/billing/billing-plans'
import type { ExecutionNode, ExecutionConnection, ExecutionEvent } from '@/lib/canvas-executor'
import { estimatePaidCharge } from '@/lib/free-quota'
import { checkFreeImagePass } from '@/lib/promotions/free-image-pass'
import { resolveChargeModel } from '@/lib/model-catalog'
import { resolveAvailableBalance } from '@/lib/billing/team'

/** Number(v) 后只保留有限值（'' / 'abc' / Infinity → undefined） */
function finiteOrUndefined(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
/** 只保留有限正数（用于按秒计价，0/负数/NaN/Infinity → undefined） */
function positiveFiniteOrUndefined(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}


// SSE 形态的画布执行入口：核心循环（拓扑排序/节点执行/计费/退款）在 src/lib/mcp/executor.ts，
// 与 MCP run_workflow 工具共用。这里只负责：鉴权 → 预检（401/400/402/404 JSON 语义）→ 事件桥接为 SSE 流。
export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 })
  }

  let body: {
    nodes: ExecutionNode[]
    connections: ExecutionConnection[]
    seedOutputs?: Record<string, Record<string, unknown>>
    executeNodeIds?: string[]
    runId?: string
    workflowName?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, message: '请求体格式错误' }, { status: 400 })
  }

  const { nodes, connections, seedOutputs, executeNodeIds, runId, workflowName } = body
  if (!Array.isArray(nodes) || !Array.isArray(connections)) {
    return NextResponse.json({ success: false, message: 'nodes 和 connections 必须是数组' }, { status: 400 })
  }

  const prisma = await getPrisma()

  // ===== 预检（必须先于流建立，才能保持 402/400/404 的 JSON 响应语义） =====
  const user = await prisma.user.findUnique({ where: { id: authUser.userId } })
  if (!user) {
    return NextResponse.json({ success: false, message: '用户不存在' }, { status: 404 })
  }
  if (runId) {
    const existing = await prisma.canvasRun.findFirst({ where: { id: runId, userId: authUser.userId } })
    if (existing && existing.status === 'CANCELLED') {
      return NextResponse.json({ success: false, message: '该执行已被取消' }, { status: 400 })
    }
  }
  // 成本预估（与 executor 内的精确预估同一逻辑，用于提前返回 402；executor 内会再次计算并预扣）
  {
    const executeIdSet = executeNodeIds && Array.isArray(executeNodeIds) ? new Set(executeNodeIds) : null
    // 每日免费额度：有剩余额度的节点先按免费估算，避免「本可免费用却因积分不足被拒」
    const chargeItems: Array<{ model: { id: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null }; points: number; beans: number }> = []
    for (const node of nodes) {
      if (executeIdSet && !executeIdSet.has(node.id)) continue
      if (node.type === 'llm-chat' || node.type === 'image-generate' || node.type === 'video-generate') {
        const type = node.type === 'video-generate' ? 'VIDEO' : node.type === 'image-generate' ? 'IMAGE' : 'TEXT'
        const modelId = node.inputs?.model ? String(node.inputs.model) : undefined
        // 与执行期同口径：指定模型失效时按类型回退到「已配 Key 且支持该能力」的模型
        const model = await resolveChargeModel(type, modelId)
        if (!model) continue
        const meta = (model.metadata as Record<string, unknown> | null) ?? null
        // 生图时长券优先于每日额度：有效期内不占次数，也不应因 0 积分被预检拒掉。
        if ((await checkFreeImagePass({ id: model.id, type, dailyUserFreeQuota: model.dailyUserFreeQuota }, user, user.id)).free) {
          continue
        }
        // 计费因子统一走 nodeChargeInputs（只接受有限值：Number('abc')=NaN、JSON 1e999=Infinity
        // 都会让预算与实扣不一致），与 executor / 工具预估保持单一口径。
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
    const { points: totalCost, beans: totalBeans } = await estimatePaidCharge(chargeItems, authUser.userId)
    // 团队共享池：按出资人余额判定（成员自己余额为 0，钱在老板账上）
    const availBal = await resolveAvailableBalance(user.id)
    if (availBal.points < totalCost) {
      return NextResponse.json({ success: false, message: availBal.isTeam ? '团队积分不足，请联系管理员充值' : '积分不足' }, { status: 402 })
    }
    if (availBal.beans < totalBeans) {
      return NextResponse.json(
        { success: false, message: availBal.isTeam ? `团队豆不足，视频节点需要 ${totalBeans} 豆，请联系管理员充值` : `豆不足，视频节点需要 ${totalBeans} 豆，请前往个人中心充值` },
        { status: 402 },
      )
    }
  }

  // ===== 预检通过：启动执行，事件桥接为 SSE 流 =====
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // 客户端中止时 controller.enqueue 会抛错；桥接 emit 吞掉写流异常，保证退款/结算代码可达
      const emit = (event: ExecutionEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          // 流已关闭/客户端已断开，忽略
        }
      }
      const closeStream = () => {
        try {
          controller.close()
        } catch {
          // 流已关闭/客户端已断开，忽略
        }
      }

      try {
        await runCanvasGraph(
          { userId: authUser.userId, nodes, connections, seedOutputs, executeNodeIds, runId, workflowName },
          emit
        )
        // 正常返回：done/cancelled/paused 事件已由 executor 内部发出并完成结算
        closeStream()
      } catch (err: unknown) {
        // 并发竞态兜底（预检通过后积分被并发扣空等）：按原语义在流内发 error 事件
        const message = err instanceof Error ? err.message : '工作流执行失败'
        emit({ type: 'error', message })
        closeStream()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
