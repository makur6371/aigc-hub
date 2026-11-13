import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { streamChatToUpstream } from '@/lib/llm-provider'
import { buildCopilotSystemPrompt, parseCopilotResponse } from '@/lib/copilot-actions'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
import { getOfficialNodeCatalog } from '@/lib/node-catalog'

/**
 * 把原始 canvasState JSON 转为 LLM 友好的结构化文本。
 * 让 Copilot 一目了然看到节点、参数和连线关系。
 */
function formatCanvasState(state: {
  nodes: {
    id: string
    type: string
    label?: string
    category?: string
    inputs?: Record<string, unknown>
    outputs?: Record<string, unknown>
    status?: string
  }[]
  connections: { id: string; sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }[]
  selectedNodeIds?: string[]
}): string {
  if (!state.nodes || !state.nodes.length) return '（画布为空）'

  const lines: string[] = []
  const selectedSet = new Set(state.selectedNodeIds || [])

  // 节点列表(完整 id,LLM 需要原样引用才能增删改)
  lines.push(`节点(${state.nodes.length}):`)
  for (const n of state.nodes) {
    const isSel = selectedSet.has(n.id) ? ' [当前选中]' : ''
    const statusLabel = n.status && n.status !== 'idle' ? ` [状态:${n.status}]` : ''

    const inputParts: string[] = []
    if (n.inputs) {
      if (typeof n.inputs.prompt === 'string' && n.inputs.prompt) {
        inputParts.push(`提示词: "${n.inputs.prompt.slice(0, 100)}${n.inputs.prompt.length > 100 ? '...' : ''}"`)
      }
      if (n.inputs.model) inputParts.push(`模型: ${n.inputs.model}`)
      if (n.inputs.width && n.inputs.height) inputParts.push(`尺寸: ${n.inputs.width}x${n.inputs.height}`)
    }
    const inputSummary = inputParts.length ? ` (配置: ${inputParts.join(', ')})` : ''

    const outputParts: string[] = []
    if (n.outputs) {
      if (typeof n.outputs.imageUrl === 'string') outputParts.push(`图片产物: ${n.outputs.imageUrl}`)
      if (typeof n.outputs.videoUrl === 'string') outputParts.push(`视频产物: ${n.outputs.videoUrl}`)
      if (typeof n.outputs.text === 'string') {
        outputParts.push(`文本产物: "${n.outputs.text.slice(0, 80)}${n.outputs.text.length > 80 ? '...' : ''}"`)
      }
    }
    const outputSummary = outputParts.length ? `\n    └─ 产物: ${outputParts.join(', ')}` : ''

    lines.push(`  - ${n.id}「${n.label || n.type}」(${n.type})${isSel}${statusLabel}${inputSummary}${outputSummary}`)
  }

  // 连线列表
  if (state.connections.length > 0) {
    lines.push(`\n连线(${state.connections.length}):`)
    for (const c of state.connections) {
      lines.push(
        `  - ${c.sourceNodeId}.${c.sourcePort} → ${c.targetNodeId}.${c.targetPort}`
      )
    }
  } else {
    lines.push('\n连线: 无')
  }

  return lines.join('\n')
}

export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  }

  try {
    const { message, canvasState, history, modelId, brainModelId, visionModelId, imageModelId, videoModelId, iteration, observation } = await request.json()
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: '消息不能为空' }), { status: 400 })
    }

    const prisma = await getPrisma()

    // 计费事务统一走 charge-run：模型解析（brainModelId 失效时按 TEXT 兜底回退到平台推荐模型）
    // + 免费额度 + 预扣 + 失败退款 + 调用日志，全部由 charge-run 负责，这里不再手写。
    let run
    try {
      run = await chargeRun({ userId: authUser.userId, modelType: 'TEXT', modelId: brainModelId, source: 'copilot' })
    } catch (err) {
      if (err instanceof ChargeRunError) {
        return new Response(JSON.stringify({ error: err.message }), { status: err.status })
      }
      throw err
    }
    const model = run.model

    // 失败收口：退款 + 写失败日志（均由 charge-run 统一处理）
    // 注意：charge-run 的 fail/settle 有 settled 幂等位，成功已 settle 后再调 fail 是 no-op，
    // 不会把「已成功但响应中断」的那次调用重复退款。
    const refund = async (errMsg: string) => {
      await run.fail(new Error(errMsg), { nodeLabel: 'Copilot 大脑', request: { message } })
    }

    // 拉可用模型清单给 Copilot（用于 updateNodeInput 设置 model）
    const allModels = await prisma.modelConfig.findMany({
      where: { isActive: true, provider: { isActive: true } },
      select: { id: true, name: true, type: true, supportsVision: true, metadata: true },
    })

    // 动态端口判定(与前端 getEffectiveNodeInfo 一致):视觉 LLM 的 image 输入、思考输出、参考图生图输入
    const hasVisionModel = allModels.some((m) => m.supportsVision || m.type === 'VISION')
    const hasThinkModel = allModels.some((m) => {
      const meta = m.metadata as Record<string, unknown> | null | undefined
      return !!(meta && typeof meta === 'object' && meta.think)
    })
    const hasRefImageModel = allModels.some((m) => {
      const modes = (m.metadata as Record<string, unknown> | null | undefined)?.modes
      return Array.isArray(modes) && (modes as unknown[]).some((x) => x === 'singleImage' || x === 'multiReference')
    })

    // 节点目录从 DB 读（权威来源）：禁用的节点与用户看不到的自定义节点
    // 都不会进目录，Copilot 只能搭出用户真正选得到的节点。
    // 之前这里直接读 BUILTIN_NODES 再单独查一次禁用表 —— 两份来源、
    // 两次查询，且禁用的自定义节点从未被排除（它只查 isDisabled 的 nodeType，
    // 而自定义节点本来就不在 BUILTIN_NODES 里，禁了也不影响 Copilot）。
    const nodeCatalog = (await getOfficialNodeCatalog())
      .map((n) => {
        const inputs = Object.fromEntries(
          Object.entries(n.inputs).map(([k, v]) => [k, { type: v.type, label: v.label, required: v.required }])
        )
        const outputs = Object.fromEntries(
          Object.entries(n.outputs).map(([k, v]) => [k, { type: v.type, label: v.label }])
        )
        // 追加动态端口,让 Copilot 看到用户实际可见的端口
        if (n.nodeType === 'llm-chat') {
          if (hasVisionModel) inputs.image = { type: 'image', label: '参考图片(需视觉模型)', required: false }
          if (hasThinkModel) outputs.reasoning = { type: 'string', label: '思考过程' }
        } else if (n.nodeType === 'image-generate' && hasRefImageModel) {
          inputs.referenceImage = { type: 'image', label: '参考图片(需支持参考图的生图模型)', required: false }
        }
        return { nodeType: n.nodeType, label: n.label, category: n.category, inputs, outputs }
      })

    const canvasSnapshot = canvasState ? formatCanvasState(canvasState) : undefined
    // 语义检索用户收藏的提示词，注入最相关的作为写提示词参考
    let promptLibraryNote = ''
    try {
      const myPrompts = await prisma.promptTemplate.findMany({
        where: { creatorId: authUser.userId, isPublic: false },
        select: { title: true, content: true, category: true, embedding: true },
      })
      if (myPrompts.length > 0) {
        const { embeddingClient: ec, cosineSimilarity } = await import('@/lib/embedding')
        const qVec = await ec.embed(message)
        let top: typeof myPrompts
        if (qVec) {
          top = myPrompts
            .filter((p) => p.embedding)
            .map((p) => ({ p, sim: (() => { try { return cosineSimilarity(qVec, JSON.parse(p.embedding as string) as number[]) } catch { return 0 } })() }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, 5)
            .map((x) => x.p)
        } else {
          top = myPrompts.slice(0, 5)
        }
        if (top.length > 0) {
          promptLibraryNote = `\n\n## 你的提示词库(已按当前需求语义检索出最相关的收藏,供参考沿用风格)\n${top
            .map((p, i) => `${i + 1}. [${p.category || '通用'}] ${p.title}：${String(p.content).slice(0, 120)}`)
            .join('\n')}\n写新的节点提示词时，可参考这些收藏的风格与结构，保持一致性。`
        }
      }
    } catch { /* 提示词库注入失败不阻塞 */ }
    // 分类型模型偏好：告诉 Copilot 创建对应类型节点时必须用哪个 model
    const typePrefs: Array<{ label: string; id?: string }> = [
      { label: '图像识别(视觉理解 llm-chat 读图)', id: visionModelId },
      { label: '生图(image-generate)', id: imageModelId },
      { label: '视频(video 节点)', id: videoModelId },
    ]
    const modelPrefNote = modelId || typePrefs.some((p) => p.id)
      ? `\n## ⚠️ 用户预设的模型偏好\n${[
          modelId ? `- 节点默认模型：\`${modelId}\`` : '',
          ...typePrefs.filter((p) => p.id).map((p) => `- ${p.label}：\`${p.id}\``),
        ].filter(Boolean).join('\n')}\n创建需要模型的节点时,必须在 createNode action 中带上 \`"model":"<对应偏好id>"\` 字段。没有对应偏好的类型省略 model 字段。\n`
      : ''
    const systemPrompt = buildCopilotSystemPrompt(nodeCatalog, allModels, canvasSnapshot, modelId) + modelPrefNote + promptLibraryNote

    const safeHistory = Array.isArray(history) ? history.slice(-10) : []
    // 第 N 轮(N>1):注入上一轮观察结果,引导自检/继续/终止
    const roundNote =
      iteration && Number(iteration) > 1
        ? `\n\n[第${iteration}轮] 上一轮执行结果: ${observation || '无'}。\n请判断任务是否已完成:若已完成,只输出 status:"done"(actions 可为空);若未完成,只做下一步行动并 status:"continue"。`
        : ''
    const messages = [
      { role: 'user', content: systemPrompt },
      ...safeHistory.map((h: { role: string; content: string }) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message + roundNote },
    ]

    // SSE 流式输出
    const encoder = new TextEncoder()
    let fullText = ''
    let streamError: string | null = null

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

        try {
        // 重试机制：最多 2 次尝试
        const maxRetries = 2
        let lastError: Error | null = null
        let succeeded = false

        for (let attempt = 0; attempt < maxRetries && !succeeded; attempt++) {
          try {
            if (attempt > 0) {
              send({ type: 'text', content: `\n\n[正在重试 ${attempt + 1}/${maxRetries}...]\n` })
            }
            await streamChatToUpstream(
              run.model.baseUrl,
              run.model.apiKey,
              model.modelName || model.name,
              { messages, temperature: 0.3 },
              (textChunk: string) => {
                fullText += textChunk
                send({ type: 'text', content: textChunk })
              },
              // 模型的实时思考流（thinking/reasoning）→ 前端思考阶段实时展示
              (reasoningChunk: string) => {
                send({ type: 'reasoning', content: reasoningChunk })
              },
              { adapterId: run.model.adapterId, configJson: run.model.configJson },
              120000, // 120秒超时
            )
            // 成功则跳出重试循环
            succeeded = true
          } catch (streamErr) {
            lastError = streamErr instanceof Error ? streamErr : new Error(String(streamErr))
            // 如果不是最后一次尝试，等待后重试
            if (attempt < maxRetries - 1) {
              await new Promise((r) => setTimeout(r, 2000))
            }
          }
        }

        if (!succeeded && lastError) {
          throw lastError
        }

        // 流结束,解析完整回复中的 actions（作为兜底）
        const parsed = parseCopilotResponse(fullText)
        send({ type: 'done', reply: parsed.reply, actions: parsed.actions, thought: parsed.thought, status: parsed.status, plan: parsed.plan, clarify: parsed.clarify })

        // 成功收口：写调用日志（含请求/响应详情、耗时）
        try {
          await run.settle({
            nodeLabel: 'Copilot 大脑',
            request: { message },
            // 只留回复正文，actions 等结构化结果对排查够用且体积可控
            response: { reply: fullText.slice(0, 4000) },
          })
        } catch { /* ignore */ }

        controller.close()
        } catch (err: unknown) {
        streamError = err instanceof Error ? err.message : 'Copilot 调用失败'

        // 如果有部分结果,返回部分结果而非完全失败
        if (fullText.trim()) {
          const partialParsed = parseCopilotResponse(fullText)
          send({
            type: 'partial',
            reply: partialParsed.reply || '⚠️ 响应中断,已返回部分结果',
            actions: partialParsed.actions,
            thought: partialParsed.thought,
            status: partialParsed.status,
            plan: partialParsed.plan,
            clarify: partialParsed.clarify,
            error: streamError
          })
        } else {
          send({ type: 'error', message: streamError })
        }

        await refund(streamError)
        controller.close()
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
  } catch (error) {
    console.error('Copilot route error:', error)
    return new Response(JSON.stringify({ error: '服务器内部错误' }), { status: 500 })
  }
}
