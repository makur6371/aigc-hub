import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { runCanvasGraph } from '@/lib/mcp/executor'
import type { ExecutionEvent } from '@/lib/canvas-executor'
import { planSharedWork } from '@/lib/tool-run-plan'
import { resolveToolRuns, computeRunCharge } from '@/lib/tool-run-charge'
import { resolveAvailableBalance } from '@/lib/billing/team'
import { getVideoCapabilities, resolveVideoMediaSlots } from '@/lib/video-capabilities'

// 并发闸门已下沉到 provider-invoker（withUpstreamGate）：
// 那里是所有打上游调用的唯一出口，工具箱 / 画布 / Copilot / Agent 一并受约束。
// 路由层不再自带限流，避免两套闸门互相叠加、口径不一致。

type Ctx = { params: Promise<{ id: string }> }


// ===== 工具执行：快照 + 面板值 → 逐分支展开 → 复用画布执行核心（SSE） =====
export async function POST(request: NextRequest, ctx: Ctx) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 })
  }
  const prisma = await getPrisma()
  const { id } = await ctx.params

  let body: { values?: Record<string, unknown>; runId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, message: '请求体格式错误' }, { status: 400 })
  }
  const values = body.values ?? {}

  // 参数槽（model/ratio）以最新识别结果为准，与工具详情接口保持一致：
  // 老工具快照里模型槽覆盖不全，会导致「只给第一个节点选了模型，其余自动兜底」。
  // 展开执行计划：多组风格 × 多张上传图 → N 份（zip 同步语义，流式逐份）
  const resolved = await resolveToolRuns(id, values)
  if ('error' in resolved) {
    return NextResponse.json({ success: false, message: resolved.error }, { status: 404 })
  }
  const { tool, wf, slots, runs } = resolved
  if (runs.length === 0) {
    return NextResponse.json({ success: false, message: '该工具没有可执行的内容' }, { status: 400 })
  }

  // 必选模型校验（服务端兜底）：前端已把模型槽标为必填并拦住提交，
  // 这里再挡一次，避免旧客户端/直接调接口时「没选模型」被静默兜底成别的模型，
  // 用默认规格发出、用户拿不到想要的图。
  // hidden 的槽位作者已隐藏（不展示、也不该拦），与前端 formSlots 口径保持一致
  // 只校验**实际执行分支**里的模型：二选一工具（如「AI 写分镜 / 直接用描述」）
  // 未选中的分支不会跑，它的模型也不该强制用户先选。
  const executedNodeIds = new Set(runs.flatMap((r) => r.executeNodeIds))
  const missingModel = slots.find(
    (s) => s.type === 'model'
      && s.required
      && !s.hidden
      && s.targets.some((t) => executedNodeIds.has(t.nodeId))
      && !(typeof values[s.id] === 'string' && values[s.id]),
  )
  if (missingModel) {
    return NextResponse.json({ success: false, message: `请先选择${missingModel.label}` }, { status: 400 })
  }

  // 必填素材校验（服务端兜底，2026-10-18）。
  //
  // 为什么不能直接读 slot.required：上传槽的 required 是**工具级写死**的旧值
  // （每个视频工具的 slots 里固定带 audioSlot/videoSlot，都是 required:false），
  // 而「视频到底要不要传」由**所选模型**的 constraints 决定（动作迁移 requireVideo、
  // 对口型 requireAudio）。这里按「当前模型 + 该槽连的端口」重新判定，
  // 与前端 slot-controls 的展示逻辑同源，避免「面板标了必填但后端不拦」。
  const modelSlot = slots.find((s) => s.type === 'model' && !s.hidden)
  const selectedModelId = modelSlot ? values[modelSlot.id] : undefined
  if (typeof selectedModelId === 'string' && selectedModelId) {
    const modelRow = await prisma.modelConfig.findFirst({
      where: { id: selectedModelId },
      select: { type: true, metadata: true },
    })
    if (modelRow?.type === 'VIDEO') {
      const cap = getVideoCapabilities(modelRow as never)
      const media = resolveVideoMediaSlots(cap)
      const hasValue = (v: unknown): boolean =>
        Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.length > 0 : v != null
      // 槽位 → 该模型要求的素材类型（按 targets 端口判定，与前端一致）
      const requiredByPort: Array<[RegExp, 'image' | 'audio' | 'video']> = [
        [/referenceVideo|(^|_)video$/, 'video'],
        [/referenceAudio|(^|_)audio$/, 'audio'],
        [/referenceImage|(^|_)images?$/, 'image'],
      ]
      for (const slot of slots) {
        if (slot.type !== 'upload' || slot.hidden) continue
        const port = slot.targets[0]?.port ?? ''
        const hit = requiredByPort.find(([re]) => re.test(port))
        if (!hit) continue
        const kindKey = hit[1]
        if (!media[kindKey] || !media[`${kindKey}Required`]) continue
        if (!hasValue(values[slot.id])) {
          const name = kindKey === 'video' ? '参考视频' : kindKey === 'audio' ? '参考音频' : '参考图'
          return NextResponse.json(
            { success: false, message: `所选模型必须上传${name}` },
            { status: 400 },
          )
        }
      }
    }
  }

  // 成果节点：只有 result 槽位指向的节点产出才算成果（上传/裁切等透传节点不算），
  // 存进 CanvasRun 供「刷新后恢复成果区」使用。
  const resultNodeIds = [...new Set(slots.filter((sl) => sl.type === 'result').flatMap((sl) => sl.targets.map((t) => t.nodeId)))]

  // ===== 3. 预检积分/豆（全部 run 合计；与 canvas execute 同逻辑） =====
  const user = await prisma.user.findUnique({ where: { id: authUser.userId } })
  if (!user) return NextResponse.json({ success: false, message: '用户不存在' }, { status: 404 })
  const { totalCost, totalBeans } = await computeRunCharge(runs, slots, authUser.userId)
  // 团队共享池：按出资人余额判定
  const availBal = await resolveAvailableBalance(user.id)
  if (availBal.points < totalCost) {
    return NextResponse.json(
      { success: false, message: (availBal.isTeam ? '团队积分不足，本次预计消耗 ' : '积分不足，本次预计消耗 ') + totalCost + ' 积分' },
      { status: 402 },
    )
  }
  if (availBal.beans < totalBeans) {
    return NextResponse.json(
      { success: false, message: availBal.isTeam ? `团队豆不足，本次预计需要 ${totalBeans} 豆，请联系管理员充值` : `豆不足，本次预计需要 ${totalBeans} 豆，请前往个人中心充值` },
      { status: 402 },
    )
  }

  // ===== 4. 逐份执行（SSE 流式；每份之间用上一份产出做 seedOutputs 复用共享素材） =====
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: ExecutionEvent, runIndex: number, total: number, label: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, runIndex, runTotal: total, runLabel: label })}\n\n`))
        } catch { /* 流已关闭 */ }
      }
      // SSE 心跳：上游排队/生成期间可能几十秒没有任何事件。
      // 中间没有任何字节时，nginx（proxy_read_timeout）和浏览器都可能判定连接空闲而断开，
      // 用户看到的就是"跑到一半没了"。每 15 秒发一个注释行保活（SSE 规范里以 ':' 开头的行会被忽略）。
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { /* 流已关闭 */ }
      }, 15000)
      const closeStream = () => {
        clearInterval(heartbeat)
        try { controller.close() } catch { /* 已关闭 */ }
      }

      // 整段执行包 try/finally：任何未捕获异常（如 planSharedWork 抛错）都必须清掉心跳，
      // 否则每来一个请求就泄漏一个 setInterval，长跑会把进程拖垮。
      try {
      let seedOutputs: Record<string, Record<string, unknown>> = {}
      // ===== 跨份共享规划（详见 @/lib/tool-run-plan 的 planSharedWork）=====
      // 多份工具（多风格 / 多格子）里，「每份都有且不依赖变体」的节点只跑一次：
      //   预跑集（如九宫格模式2 的「切成九格」）→ 先跑一遍，产出广播给所有份；
      //   透传节点（上传 / 文本口）→ 直接播种，不执行。
      // 单份工具没有可复用的东西，保持一次整图执行。
      const { sharedExecIds, passthroughSeed, globallyHandled } = planSharedWork(runs, slots, wf.connections)
      seedOutputs = { ...seedOutputs, ...passthroughSeed }

      if (sharedExecIds.length > 0) {
        const captured: Record<string, Record<string, unknown>> = {}
        try {
          await runCanvasGraph(
            {
              userId: authUser.userId,
              nodes: runs[0].nodes,
              connections: runs[0].connections,
              seedOutputs,
              executeNodeIds: sharedExecIds,
              surface: 'tool',
              surfaceId: tool.id,
              workflowName: `${tool.name} · 预处理`,
            },
            (event) => {
              if (event.type === 'nodeOutput' && event.output) captured[event.nodeId] = event.output
              // 预处理事件也转发（前端按 resultNodeIds 过滤，裁切/上传不会进成果区）
              // runTotal 传 1：预跑不是「第 N 格」，避免进度条被误标成「第 1/9 格」
              emit(event, 0, 1, '预处理')
            },
          )
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '预处理失败'
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)) } catch { /* 已关闭 */ }
          closeStream()
          return
        }
        seedOutputs = { ...seedOutputs, ...captured }
      }

      // ===== 各份并发执行 =====
      // 每份是独立子图 + 独立预算池（各自预扣/结算），互不阻塞；
      // 用 allSettled 做失败隔离：某一份失败不影响其他份，各自照常退款。
      //
      // 这里**不再自己排队**：全部同时派发，由 provider-invoker 的 withUpstreamGate
      // 统一按「派发速率 + 在途上限」节流。这样各份能尽早进入「等待上游返回」，
      // 而不是被路由层的 12 个名额串行压住（旧实现：12 名额被占满后第 13 份要干等 40 秒）。
      const settled = await Promise.allSettled(
        runs.map((run, i) =>
          runCanvasGraph(
            {
              userId: authUser.userId,
              nodes: run.nodes,
              connections: run.connections,
              seedOutputs,
              // 只剔除「确实已全局处理」的节点（预跑过的共享节点 + 已播种的透传节点）
              executeNodeIds: run.executeNodeIds.filter((id) => !globallyHandled.has(id)),
              surface: 'tool',
              surfaceId: tool.id,
              resultNodeIds: resultNodeIds,
              workflowName: `${tool.name}${runs.length > 1 ? ` · ${run.label}` : ''}`,
            },
            (event) => emit(event, i, runs.length, run.label),
          ),
        ),
      )

      // 汇总失败：逐份报错，不掩盖成功部分
      const failures = settled
        .map((r, i) => (r.status === 'rejected' ? { label: runs[i].label, reason: r.reason } : null))
        .filter((x): x is { label: string; reason: unknown } => x !== null)
      for (const f of failures) {
        const message = f.reason instanceof Error ? f.reason.message : '执行失败'
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: `${f.label || '任务'}：${message}` })}\n\n`))
        } catch { /* 已关闭 */ }
      }
      } catch (err: unknown) {
        // 兜底：把意外异常也告诉前端，别让用户对着一个永远转圈的卡片等
        const message = err instanceof Error ? err.message : '执行异常'
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`))
        } catch { /* 已关闭 */ }
      } finally {
        closeStream()
      }
    },
  })

  // 使用计数（异步，不阻塞流）
  prisma.tool.update({ where: { id: tool.id }, data: { useCount: { increment: 1 } } }).catch(() => {})

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}


/**
 * 预估接口：返回本次运行的确切积分/豆消耗（含免费额度抵扣）。
 * 「开始生成」旁显示的数字来自这里，与真实扣费同一套计算，不再是「约」。
 */
export async function PUT(request: NextRequest, ctx: Ctx) {
  const authUser = await getAuthUser(request)
  if (!authUser) return NextResponse.json({ success: false, message: '未登录' }, { status: 401 })
  const { id } = await ctx.params

  let body: { values?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, message: '请求体格式错误' }, { status: 400 })
  }
  const resolved = await resolveToolRuns(id, body.values ?? {})
  if ('error' in resolved) {
    return NextResponse.json({ success: false, message: resolved.error }, { status: 404 })
  }
  const { slots, runs } = resolved
  if (runs.length === 0) {
    return NextResponse.json({ success: true, data: { points: 0, beans: 0, runs: 0 } })
  }
  const { totalCost, totalBeans } = await computeRunCharge(runs, slots, authUser.userId)
  return NextResponse.json({ success: true, data: { points: totalCost, beans: totalBeans, runs: runs.length } })
}
