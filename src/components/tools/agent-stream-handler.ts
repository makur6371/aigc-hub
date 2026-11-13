// Agent SSE 事件 → 界面（气泡 + 成果区）。**唯一实现**，两条路径共用。
//
// ===== 为什么必须抽出来 =====
// 这段逻辑原来内联在 ToolAgentPanel 的 send() 里。加了「执行前确认」之后，
// confirm 走的是**另一个接口**，如果照抄一份，就会出现两份实现 ——
// 而本项目已经反复吃过这个亏（历史丢 decisions/plan、历史丢失败原因，
// 都是「实时一份、历史一份」漂移出来的）。
//
// 更关键的是：confirm 最初被写成**一次性 JSON**，没有事件流 ——
// 于是「排队占位」根本不会出现，用户要等生成完才看到图（本次报的 bug）。
// 把它改成流式时，事件处理必须和 /send 完全一致，所以只留这一份。

import { notify } from '@/lib/browser-notify'
import { useToolRunStore, type ResultKind } from '@/stores/useToolRunStore'
import { friendlyLlmError } from '@/lib/friendly-llm-error'
import { normalizeAskQuestions, normalizeDecisions, normalizePendingActions, type AgentMessage } from '@/lib/agent-message'

export interface AgentStreamHandlerOpts {
  /** 本条助手消息的 id —— 成果区占位的认领键（agent-<id>-<deliverableId>）用它拼 */
  assistantMsgId: string
  /** 更新本条助手消息（气泡内容/计划卡/确认卡） */
  patchAssistant: (patch: Partial<AgentMessage>) => void
  /** 后端自动建会话后回传 sessionId 时调用（打通多轮上下文） */
  setSessionId?: (sid: string) => void
  /** 后端回传 taskId 时调用；停止按钮必须拿它去调服务端取消接口 */
  setTaskId?: (taskId: string) => void
}

export function createAgentStreamHandler(opts: AgentStreamHandlerOpts) {
  const { assistantMsgId, patchAssistant, setSessionId, setTaskId } = opts
  const planSteps = new Map<string, { label: string; status: 'running' | 'success' | 'failed'; videoRecordIds?: string[] }>()
  const deliverableSteps = new Map<string, string>()
  let thinkingBuf = ''
  let taskDone = false

  const handleEvent = (ev: Record<string, unknown>) => {
  const type = String(ev.type || '')
  if (type === 'task') {
    // 后端自动创建会话后回传 sessionId → 打通多轮上下文
    const sid = typeof ev.sessionId === 'string' ? ev.sessionId : ''
    if (sid) setSessionId?.(sid)
    const tid = typeof ev.taskId === 'string' ? ev.taskId : ''
    if (tid) {
      // Agent 的进度在气泡里展示，不走工具模式排队占位；但 taskId 必须保留，
      // 否则「停止」只能断 SSE，服务端仍会继续生成并扣费。
      setTaskId?.(tid)
    }
  } else if (type === 'thinking') {
    // 流式思考：追加 delta；done 后停更
    const delta = String(ev.delta || '')
    if (delta) {
      thinkingBuf += delta
      patchAssistant({ thinking: thinkingBuf })
    }
  } else if (type === 'subtask') {
    const idx = Number(ev.index)
    const key = `${idx}`
    const label = String(ev.label || '')
    const st = String(ev.status)
    if (st === 'running' || st === 'processing') planSteps.set(key, { ...planSteps.get(key), label, status: 'running' })
    else if (planSteps.has(key)) planSteps.get(key)!.status = st === 'success' ? 'success' : 'failed'
    patchAssistant({
      plan: { title: '执行计划', steps: [...planSteps.values()] },
    })
    // 生图子任务开跑时，同步在成果区置顶排队占位（与工具模式同一套机制），
    // 生成成功后由 media 事件落位为真实图片。
    if (st === 'running') {
      const label = String(ev.label || '')
      const mediaType = /[（(](image|video|audio)[）)]/.exec(label)?.[1]
      if (mediaType === 'image' || mediaType === 'video' || mediaType === 'audio') {
        // 占位按「子任务 × 张数」精确创建，与工具模式同一套 queueId/queueIndex 机制；
        // media 事件回来时按 deliverableId + index 认领替换。
        const deliverableId = String(ev.deliverableId || ev.id || `${idx}`)
        deliverableSteps.set(deliverableId, key)
        const count = Math.max(1, Number(ev.count) || 1)
        const queueId = `agent-${assistantMsgId}-${deliverableId}`
        const note = label.replace(/\s*[（(](image|video|audio)[）)]\s*$/, '')
        useToolRunStore.getState().setResults((prev) => [
          ...Array.from({ length: count }, (_, i) => ({
            url: '', kind: mediaType as ResultKind, nodeId: assistantMsgId, status: 'running' as const,
            queueId, queueIndex: i, queueNote: count > 1 ? `${note} ${i + 1}/${count}` : note,
            // 与工具模式对齐：刚开跑还没打上游 → 相位留空（显示「准备中」），
            // 等后端 nodePhase 事件回填 queued/running（「等待派发 / 生成中 + 计时」）。
            phase: undefined, phaseSince: Date.now(),
            // Agent 的规划模型先跑过一轮（thinking）—— 阶段流程条据此多显示
            // 「优化提示词中 / 已理解需求」这一段。工具面板/画布不置此标记。
            hasLlmStage: true,
            toolName: '智能体', createdAt: Date.now() + i,
          })),
          ...prev.filter((r) => r.queueId !== queueId),
        ])
      }
    } else if (st === 'failed') {
      // 失败原因必须透传：后端 subtask 事件带 error 字段（runDeliverable 失败时 emit）。
      // 以前这里只把占位改成 error，原因被丢掉 → 用户看到红标题却啥也干不了。
      const failReason = String(ev.error || '')
      if (failReason) patchAssistant({ error: failReason })
      const deliverableId = String(ev.deliverableId || '')
      if (deliverableId) {
        const queueId = `agent-${assistantMsgId}-${deliverableId}`
        useToolRunStore.getState().setResults((prev) =>
          prev.map((r) => (r.queueId === queueId && r.status === 'running')
            ? { ...r, status: 'error' as const, failReason: failReason || undefined, queueId: undefined, queueIndex: undefined }
            : r))
      }
    }
  } else if (type === 'nodePhase') {
    // 上游相位：queued=闸门排队（等待派发）/ running=已发出（生成中）。
    // 与工具面板同一套语义，前端据此把占位文案从「准备中」推进到
    // 「等待派发 → 生成中 + 计时」。按 (deliverableId, index) 精确落位 ——
    // 与 media 事件的认领键一致，多份并发时不会串位。
    const phase = ev.phase === 'running' ? 'running' as const : 'queued' as const
    const at = Number(ev.at) || Date.now()
    const idx = Number(ev.index) || 0
    const deliverableId = String(ev.deliverableId || '')
    const queueId = deliverableId ? `agent-${assistantMsgId}-${deliverableId}` : ''
    if (queueId) {
      useToolRunStore.getState().setResults((prev) => prev.map((r) =>
        r.queueId === queueId && r.status === 'running' && r.queueIndex === idx
          ? { ...r, phase, phaseSince: at }
          : r))
    }
  } else if (type === 'pendingVideo') {
    const recordId = typeof ev.recordId === 'string' ? ev.recordId : ''
    if (!recordId) return
    const deliverableId = String(ev.deliverableId || '')
    const queueId = `agent-${assistantMsgId}-${deliverableId}`
    const index = Number(ev.index) || 0
    const recoveryId = `recovery:video:${recordId}`
    const stepKey = deliverableSteps.get(deliverableId)
    const step = stepKey === undefined ? undefined : planSteps.get(stepKey)
    if (step) {
      step.videoRecordIds = [...new Set([...(step.videoRecordIds || []), recordId])]
      patchAssistant({ plan: { title: '执行计划', steps: [...planSteps.values()] } })
    }
    useToolRunStore.getState().setResults((prev) => {
      const slot = prev.find((item) => item.queueId === queueId && item.queueIndex === index && item.status === 'running')
      return [{
        ...slot, url: '', kind: 'video', nodeId: slot?.nodeId || assistantMsgId, status: 'running',
        queueId: recoveryId, queueIndex: 0, queueNote: slot?.queueNote || '视频生成中',
        toolName: '智能体', phase: 'running', phaseSince: slot?.phaseSince || Date.now(),
        createdAt: slot?.createdAt || Date.now(),
      }, ...prev.filter((item) => item !== slot && item.queueId !== recoveryId)]
    })
    window.dispatchEvent(new Event('toolhub:recover-results'))
  } else if (type === 'media') {
    const url = String(ev.url || '')
    if (!url) return
    const deliverableId = String(ev.deliverableId || '')
    const idx = Number(ev.index) || 0
    const kind = ev.kind === 'video' ? 'video' as const : ev.kind === 'audio' ? 'audio' as const : 'image' as const
    const queueId = deliverableId ? `agent-${assistantMsgId}-${deliverableId}` : ''
    useToolRunStore.getState().setResults((prev) => {
      // 认领对应排队占位（与工具模式 settle 同一语义：原地替换，不留孤儿）
      const claimed = queueId
        ? prev.some((r) => r.queueId === queueId && r.status === 'running' && r.queueIndex === idx)
        : false
      if (claimed) {
        return prev.map((r) =>
          r.queueId === queueId && r.status === 'running' && r.queueIndex === idx
            ? { ...r, url, kind, status: 'done' as const, toolName: '智能体', createdAt: Date.now(), queueId: undefined, queueIndex: undefined }
            : r,
        )
      }
      // 无对应占位（如文本模型直出图）→ 直接追加
      return [
        { url, kind, nodeId: assistantMsgId, status: 'done' as const, styleLabel: 'Agent', toolName: '智能体', createdAt: Date.now() },
        ...prev,
      ]
    })
  } else if (type === 'content') {
    patchAssistant({ content: (ev.content as string) || '' })
  } else if (type === 'awaitingConfirm') {
    // confirm 模式：规划完但未执行，把待确认项交给消息，渲染确认卡等用户点击
    const pending = normalizePendingActions(ev.pendingActions)
    patchAssistant({
      status: 'done',
      pendingActions: pending.length > 0 ? pending : undefined,
      pendingTaskId: String(ev.taskId || ''),
    })
  } else if (type === 'agentReply') {
    // askQuestions：Agent 反问时带出的结构化选项 → 渲染成可点按钮，
    // 用户不必照着手打（原先只有文字，用户得自己复述「A」或整句）
    // decisions：模型/比例/档位等关键决策 → 「用了什么参数」卡片（后端一直在发，
    // 但前端从没渲染过，等于白存）
    const askQuestions = normalizeAskQuestions(ev.askQuestions)
    const decisions = normalizeDecisions(ev.decisions)
    patchAssistant({
      content: String(ev.reply || ''),
      status: 'done',
      askQuestions: askQuestions.length > 0 ? askQuestions : undefined,
      decisions: decisions.length > 0 ? decisions : undefined,
    })
  } else if (type === 'error') {
    patchAssistant({ status: 'failed', error: friendlyLlmError(String(ev.message || '生成失败')) })
    taskDone = true
    // 整体失败：把本消息所有残留占位标为失败
    useToolRunStore.getState().setResults((prev) =>
      prev.map((r) => (r.status === 'running' && typeof r.queueId === 'string' && r.queueId.startsWith(`agent-${assistantMsgId}-`))
        ? { ...r, status: 'error' as const, queueId: undefined, queueIndex: undefined }
        : r))
  } else if (type === 'cancelled') {
    taskDone = true
    patchAssistant({ status: 'done', content: '（已取消）' })
    useToolRunStore.getState().setResults((prev) =>
      prev.map((r) => (r.status === 'running' && typeof r.queueId === 'string' && r.queueId.startsWith(`agent-${assistantMsgId}-`))
        ? { ...r, status: 'error' as const, failReason: '已取消', queueId: undefined, queueIndex: undefined }
        : r))
  } else if (type === 'done') {
    taskDone = true
    // 全部完成 → 通知。页面切到别的标签页时用户也能知道（这是用户明确要的能力）。
    // notify 内部只在「页面不可见」时真发，正盯着看不会被系统通知打断。
    {
      const ok = Array.isArray(ev.subtasks)
        ? (ev.subtasks as Array<{ status?: string }>).filter((s) => s?.status === 'success').length
        : 0
      const fail = Array.isArray(ev.subtasks)
        ? (ev.subtasks as Array<{ status?: string }>).filter((s) => s?.status === 'failed').length
        : 0
      if (ok > 0 || fail > 0) {
        notify(
          fail > 0 ? '智能体任务部分完成' : '智能体任务已完成',
          fail > 0 ? `成功 ${ok} 个、失败 ${fail} 个，点击查看结果` : `已生成 ${ok} 个结果，点击查看`,
        )
      }
    }
    // 收尾兜底：清理本消息残留的排队占位（异常路径/漏发 media 时不至于一直「生成中」）
    useToolRunStore.getState().setResults((prev) => {
      let touched = false
      const next = prev.map((r) => {
        if (r.status === 'running' && typeof r.queueId === 'string' && r.queueId.startsWith(`agent-${assistantMsgId}-`)) {
          touched = true
          return { ...r, status: 'done' as const }
        }
        return r
      })
      return touched ? next : prev
    })
  }
  }

  return { handleEvent, isDone: () => taskDone }
}
