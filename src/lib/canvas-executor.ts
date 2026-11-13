import { streamChatToUpstream } from './llm-provider'
import { resolveTierCost } from './billing/billing-plans'
import { generateImage, generateVideo, queryVideoStatus, generateAudio, queryAudioStatus } from './media-provider'
import { fetchModelSizes } from './provider-invoker'
import { runPerception, isolateVoice } from './perception'
import { cropImageRegions, cropImageGrid, createGridGif, isGifSource } from './image-processor'
import { parsePromptBlocks } from './json-blocks'
import { decodeSize } from './image-sizes'
import { normalizeVideoResolution } from './video-capabilities'
import { activeDiscount, effectivePoints } from './pricing'
import { isAutoLlm } from './auto-llm'
import { planNodeCharge, nodeChargeInputs, resolvePerSecondPoints, validateVideoParams } from './billing/billing-plans'
import { ASSET_MAX_SIZE, saveAssetFile, saveAssetWithRecord } from './asset-store'
import { EXPIRED_ASSET_MESSAGE, toUpstreamMediaUrl, persistDataUrl, persistDataUrls, persistForUpstream, isLocalAssetAlive } from './upstream-image'
import {
  buildNineGridLoopPrompt,
  buildNativeGifPrompt,
  normalizeGrid,
  normalizeOutputMode,
  parseNineGridScript,
  gridFrameCount,
  NINE_GRID_LOOP_DEFAULT_NEGATIVE_PROMPT,
} from './nine-grid-loop'

// 画布 LLM 节点超时：比默认 chat 超时(60s)宽松，覆盖「读图 + 慢推理模型」场景
const CHAT_NODE_TIMEOUT_MS = 150000
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { PrismaClient } from '@prisma/client'
import vm from 'node:vm'

// 站内素材公网 URL：NEXT_PUBLIC_APP_URL 兜底生产域名（route handler 里 request.url 是内网 host，
// 不能拿来拼外发链接，见 payment-gateway 经验）
const PUBLIC_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')

async function readLocalAsset(url: string): Promise<Buffer | null> {
  const { ASSET_DIR } = await import('./asset-store')
  const rel = url.slice(url.startsWith('/api/asset/') ? '/api/asset/'.length : '/generated/'.length)
  try {
    return await readFile(join(ASSET_DIR, rel))
  } catch {
    return null
  }
}



export interface ExecutionNode {
  id: string
  type: string
  label: string
  category: string
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
}

export interface ExecutionConnection {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  index?: number // 可选:取上游数组输出的第 N 个元素
}

export type ExecutionEvent =
  | { type: 'nodeStart'; nodeId: string }
  | { type: 'nodeProgress'; nodeId: string; message: string } // 中间过程信号，不代表节点完成
  // 上游相位：queued=还在闸门排队（等待派发），running=已发出、等待上游返回
  // at=相位切换的客户端时间戳，前端据此展示等待/生成计时
  | { type: 'nodePhase'; nodeId: string; phase: 'queued' | 'running'; at: number }
  /**
   * 节点产出。meta 携带「这条成果是谁生成的」——完成态卡片要展示模型/耗时/扣费，
   * 但这些信息只在执行期知道，事件过后就没了（此前完成卡片只剩一个 label）。
   */
  | { type: 'nodeOutput'; nodeId: string; output: Record<string, unknown>; meta?: { modelName?: string; durationMs?: number; costPoints?: number; costBeans?: number } }
  | { type: 'nodeError'; nodeId: string; error: string }
  // done 事件带 runId：前端把排队位与 CanvasRun 关联，刷新后能据此恢复
  | { type: 'done'; outputs: Record<string, Record<string, unknown>>; runId?: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled'; runId?: string }
  | { type: 'paused'; runId?: string }
  | { type: 'batchExpanded'; copies: unknown[]; conns: ExecutionConnection[]; mainConnId: string }

export interface NodeModel {
  id: string
  modelName: string
  type?: string
  costPoints: number
  videoCost?: number | null
  discount?: number | null
  isFree?: boolean
  dailyUserFreeQuota?: number | null
  dailyPlatformFreeQuota?: number | null
  supportsVision: boolean
  metadata?: Record<string, unknown>
  provider: { baseUrl: string; apiKey: string | null; adapterId?: string | null; configJson?: Record<string, unknown> | null }
}

export interface NodeContext {
  prisma: PrismaClient
  userId: string
  emit: (event: ExecutionEvent) => Promise<void> | void
  findModel: (type?: string, modelId?: string) => Promise<NodeModel | null>
  /** Auto-LLM 候选链（按 Agent 全局配置排序；缺省时仅执行单个模型）。 */
  findModelCandidates?: (type?: string) => Promise<NodeModel[]>
  // model 传入时，节点执行方会先尝试占用该模型的每日免费额度；占用成功则本次不计费
  // tier：本次请求的清晰度档位，用于 metadata.freeQuotaMaxTier 的档位上限判定
  deductPoints: (points: number, description: string, model?: { id: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null; metadata?: Record<string, unknown> | null }, tier?: string | null) => Promise<void>
  // model 传入时，节点执行方会先尝试占用该模型的每日免费额度；占用成功则本次不计费
  deductBeans: (beans: number, description: string, model?: { id: string; dailyUserFreeQuota?: number | null; dailyPlatformFreeQuota?: number | null; metadata?: Record<string, unknown> | null }, tier?: string | null) => Promise<void>
  getNodeSpec: (nodeType: string) => Promise<{ codeSchema: string } | null>
}

export function topologicalSort(nodes: ExecutionNode[], connections: ExecutionConnection[]): ExecutionNode[] {
  const nodeMap = new Map<string, ExecutionNode>()
  nodes.forEach((n) => nodeMap.set(n.id, n))

  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  nodes.forEach((n) => {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  })

  connections.forEach((conn) => {
    if (adj.has(conn.sourceNodeId) && inDegree.has(conn.targetNodeId)) {
      adj.get(conn.sourceNodeId)!.push(conn.targetNodeId)
      inDegree.set(conn.targetNodeId, inDegree.get(conn.targetNodeId)! + 1)
    }
  })

  const queue: string[] = []
  inDegree.forEach((degree, id) => {
    if (degree === 0) queue.push(id)
  })

  const result: ExecutionNode[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodeMap.get(id)!
    result.push(node)

    for (const next of adj.get(id)!) {
      inDegree.set(next, inDegree.get(next)! - 1)
      if (inDegree.get(next) === 0) {
        queue.push(next)
      }
    }
  }

  if (result.length !== nodes.length) {
    throw new Error('工作流中存在循环依赖，请检查连线')
  }

  return result
}

// 图片类值判定：多图聚合只对图片生效，文本/数值口保持原有后写覆盖语义
function isImageLikeValue(v: unknown): boolean {
  const isImg = (s: string) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(s)
  if (typeof v === 'string') return isImg(v)
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && isImg(x))
}

export function resolveInputs(
  node: ExecutionNode,
  connections: ExecutionConnection[],
  outputs: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  const result = { ...node.inputs }

  const incoming = connections.filter((c) => c.targetNodeId === node.id)
  for (const conn of incoming) {
    const sourceOutput = outputs[conn.sourceNodeId]
    // image-upload 多图模式产出 {images:[...]}，而连线声明的源口可能是 image——按可用产出回退取值
    const outPort = sourceOutput && !(conn.sourcePort in sourceOutput) && 'images' in sourceOutput && conn.sourcePort === 'image'
      ? 'images'
      : conn.sourcePort
    if (sourceOutput && outPort in sourceOutput) {
      const val = sourceOutput[outPort]
      // 跳过 null/undefined，避免上游未产出的值冲掉节点已有输入
      if (val !== null && val !== undefined) {
        // 连线标记了 index 且上游输出是数组 → 按索引取单元素
        if (conn.index !== undefined && Array.isArray(val)) {
          result[conn.targetPort] = conn.index < val.length ? val[conn.index] : null
        } else {
          // 同端口多条连线：图片类值聚成数组（"连线即引用"多图源，如两个上传→LLM 图片口）；
          // 非图片值保持原有后写覆盖语义，避免污染文本/数值口
          const existing = result[conn.targetPort]
          if (isImageLikeValue(existing) && isImageLikeValue(val) && existing !== val) {
            const arr = Array.isArray(existing) ? existing : [existing]
            if (Array.isArray(val)) {
              for (const v of val as unknown[]) {
                if (!arr.includes(v)) arr.push(v)
              }
            } else {
              if (!arr.includes(val)) arr.push(val)
            }
            result[conn.targetPort] = arr
          } else {
            result[conn.targetPort] = val
          }
        }
      }
    }
  }

  return result
}

export async function executeNode(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  switch (node.type) {
    case 'llm-chat':
      return executeLLMChat(node, inputs, ctx)
    case 'condition-check':
      return executeCondition(node, inputs)
    case 'text-concat':
      return executeTextConcat(inputs)
    case 'number-calc':
      return executeNumberCalc(inputs)
    case 'text-input':
      return { text: String(inputs.content ?? '') }
    case 'json-parser': {
      const raw = String(inputs.jsonInput ?? '').trim()
      if (!raw) return { items: [], itemCount: 0 }
      let parsed: unknown[] = []
      try {
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          parsed = data
        } else if (data && typeof data === 'object') {
          // 万能解析:找对象中最长的数组属性(不管叫 items/data/results/images...)
          let bestKey: string | null = null
          let bestLen = 0
          for (const k of Object.keys(data)) {
            if (Array.isArray((data as Record<string, unknown>)[k]) && ((data as Record<string, unknown>)[k] as unknown[]).length > bestLen) {
              bestKey = k
              bestLen = ((data as Record<string, unknown>)[k] as unknown[]).length
            }
          }
          parsed = bestKey ? (data as Record<string, unknown>)[bestKey] as unknown[] : [data]
        } else {
          parsed = [data]
        }
      } catch {
        parsed = raw.split('\n').filter((l) => l.trim())
      }
      return { items: parsed, itemCount: parsed.length }
    }
    case 'number-input':
      return { value: Number(inputs.value) || 0 }
    case 'field-extractor': {
      const items = Array.isArray(inputs.items) ? inputs.items : []
      const field = String(inputs.field ?? 'prompt')
      const values = items.map((item: unknown) => {
        if (item && typeof item === 'object' && field in (item as Record<string, unknown>)) {
          return (item as Record<string, unknown>)[field]
        }
        return item
      })
      return { values, count: values.length }
    }
    case 'json-prompt-batch': {
      const field = String(inputs.field ?? 'prompt')
      const { values } = parsePromptBlocks(inputs.json, field)
      return { prompts: values, count: values.length }
    }
    case 'text-preview':
      return { text: String(inputs.text ?? '') }
    case 'image-preview':
      return { imageUrl: String(inputs.imageUrl ?? '') }
    case 'image-upload':
      // 上传的 base64 落地为静态 URL，下游拿到的一律是可持久引用的地址。
      // 并列上传节点聚合成数组后，保持数组让下游整组消费。
      if (Array.isArray(inputs.image)) {
        const urls = await persistDataUrls(inputs.image.map(String), ctx.userId)
        return { images: urls, imageUrl: urls, count: inputs.image.length }
      }
      return { imageUrl: await persistDataUrl(String(inputs.image ?? ''), ctx.userId) }
    case 'image-upload-batch': {
      const raw = Array.isArray(inputs.images) ? inputs.images.map(String) : []
      return { images: await persistDataUrls(raw, ctx.userId), count: raw.length }
    }
    case 'image-crop': {
      const regions = (inputs.cropRegions as { x: number; y: number; width: number; height: number }[] | undefined) || []
      const imageUrl = await persistDataUrl(String(inputs.imageUrl ?? ''), ctx.userId)
      if (!imageUrl) throw new Error('裁切节点缺少图片输入')
      // 两种模式：
      //   grid4 / grid9 —— 自动均分宫格（无需作者手工框选，供「整图切格 → 各格单独处理」的工作流用）
      //   single / 有 cropRegions —— 按工作台框选/点选的区域裁切
      const mode = String(inputs.mode ?? 'single')
      const grid = mode === 'grid9' ? 9 : mode === 'grid4' ? 4 : 0
      let images: string[]
      if (grid > 0 && regions.length === 0) {
        images = await cropImageGrid(imageUrl, grid === 9 ? 3 : 2, ctx.userId)
      } else {
        if (regions.length === 0) throw new Error('请先打开工作台选择裁切区域')
        images = await cropImageRegions(imageUrl, regions, ctx.userId)
      }
      return { images: await persistDataUrls(images, ctx.userId) }
    }
    case 'face-doodle': {
      // 涂鸦的检测/绘制在工作台的浏览器端完成（MediaPipe 无法在 Node 跑），
      // 确认时已上传成站内 URL 或 data URL 写回 inputs.imageUrl；
      // 执行器只负责把地址规范化为持久输出（data URL 落盘 → /api/asset/...）。
      const raw = String(inputs.imageUrl ?? '')
      if (!raw) throw new Error('请先打开涂鸦工作台生成涂鸦结果（或连接图片输入后在工作台确认出图）')
      const imageUrl = await persistDataUrl(raw, ctx.userId)
      if (!imageUrl) throw new Error('涂鸦节点缺少图片输入')
      return { imageUrl }
    }
    case 'array-expand': {
      // 兼容 items/images 两种输入命名（模板用 items，旧定义用 images）
      const arr = Array.isArray(inputs.items)
        ? inputs.items
        : (Array.isArray(inputs.images) ? inputs.images : [])
      return { items: arr, images: arr }
    }
    case 'image-generate':
      return executeImageGenerate(node, inputs, ctx)
    case 'nine-grid-loop':
      return executeNineGridLoop(node, inputs, ctx)
    case 'grid9-to-gif':
      return executeGrid9ToGif(node, inputs, ctx)
    case 'video-generate':
      return executeVideoGenerate(node, inputs, ctx)
    case 'audio-generate':
      return executeAudioGenerate(node, inputs, ctx)
    case 'music-generate':
    case 'tts-generate':
      return executeAudioGenerate(node, inputs, ctx)
    case 'sfx-generate':
      return executeSfxGenerate(node, inputs, ctx)
    case 'voice-isolate':
      return executeVoiceIsolate(node, inputs, ctx)
    case 'audio-upload':
      // 音频上传节点：透传 audio（供下游 ASR/人声分离/预览节点接线）
      return { audio: Array.isArray(inputs.audio) ? inputs.audio : String(inputs.audio ?? '') }
    case 'audio-preview':
      // 音频预览节点：原样透传（画布上真正播放的是前端卡身，这里只把地址送到输出口）
      return { audioUrl: String(inputs.audioUrl ?? '') }
    case 'video-preview':
      // 视频预览节点：原样透传（同上）
      return { videoUrl: String(inputs.videoUrl ?? '') }
    case 'video-upload':
      //
      // 为什么以前没有这个分支：节点定义与槽位识别（tool-slots.ts）里 video-upload
      // 一直都在，但 executeNode 漏了分支 —— 也就是「面板能画出这个口、连线也能建，
      // 一跑就炸」。节点类型没有执行分支 = 空壳（本项目已踩过同类坑）。
      //
      // ⚠️ 空值必须**返回空串**而不是抛错（2026-10-18 修）：
      //   视频工具（多图参考生视频 / 文生视频）的槽位把参考视频标成 `required: false`，
      //   但 `vi1` 这个 video-upload 节点是**恒定存在于工具预设工作流里**的 ——
      //   用户不填这个可选槽时，工作流照样会遍历到该节点。
      //   原来这里 `if (!raw) throw` 于是直接报「视频上传节点缺少视频输入」，
      //   表现为「我只是没上传可选视频，却被告知没上传视频」。
      //   正确语义与 audio-upload 一致：没填就透传空串，下游按「无参考视频」处理。
      // 视频与图片不同：体积大、不落盘成站内地址，上游必须自己拉 —— 站内相对路径要先补全。
      {
        const raw = inputs.video
        if (Array.isArray(raw)) {
          const urls = raw.filter((url): url is string => typeof url === 'string' && url.length > 0)
          return { video: await Promise.all(urls.map((url) => toUpstreamMediaUrl(url))) }
        }
        const url = String(raw ?? '')
        return { video: url ? await toUpstreamMediaUrl(url) : '' }
      }
    case 'transcribe':
      return executePerception(node, inputs, ctx, 'asr')
    case 'ocr':
      return executePerception(node, inputs, ctx, 'ocr')
    default:
      // 自定义节点：沙箱执行 codeSchema
      return executeCustomNode(node, inputs, ctx)
  }
}

async function executeLLMChat(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const systemPrompt = String(inputs.systemPrompt || '')
  const temperature = Number(inputs.temperature ?? 0.7)
  const modelId = inputs.model ? String(inputs.model) : undefined
  // 图片输入：凡是连进 LLM 节点的上游图片——单图(image) 或 数组(referenceImage)——一律自动收集，
  // 运行时不依赖用户在 prompt 中的指代也已全部附给模型（对齐主流"连线即引用"）。
  const imageInput = inputs.image
  const singleImgs = Array.isArray(imageInput)
    ? imageInput.map(String).filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
    : (typeof imageInput === 'string' && imageInput ? [imageInput] : [])
  const refInput = inputs.referenceImage
  const refImgs = Array.isArray(refInput)
    ? refInput.map(String).filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
    : (typeof refInput === 'string' && refInput ? [refInput] : [])
  // 跨端口去重：与生图节点同口径（同一源可能被同时接到 image + referenceImage 两个口）
  const allRaw = Array.from(new Set([...singleImgs, ...refImgs]))
  // 提示词原样透传（@图N 旧语法已废弃；用户用「第一张图/第二张图…」自然语言指代，各模型理解一致）
  const prompt = String(inputs.prompt || '').trim()
  const images = allRaw
  for (const image of images) {
    if (!(await isLocalAssetAlive(image))) throw new Error(EXPIRED_ASSET_MESSAGE)
  }

  if (!prompt) {
    throw new Error('LLM 节点的提示词不能为空')
  }

  await ctx.emit({
    type: 'nodeProgress',
    nodeId: node.id,
    message: /分镜/.test(node.label) ? 'AI 正在写分镜...' : 'AI 正在生成文本...',
  })

  const runUpstream = (model: NodeModel, p: { prompt: string; images?: string[] }) => {
    if (!model.provider.apiKey) throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
    let fullReasoning = ''
    return streamChatToUpstream(
      model.provider.baseUrl,
      model.provider.apiKey,
      model.modelName,
      {
        systemPrompt,
        messages: [{ role: 'user', content: p.prompt }],
        temperature,
        supportsVision: model.supportsVision || model.type === 'VISION',
        images: p.images && p.images.length > 0 ? p.images : undefined,
        modelMetadata: model.metadata,
        // 一大段思维链，且长度不可预测：实测 max_tokens=2048 时思维链会把预算吃光、
        // 正文为空（下游生图节点随即报「提示词不能为空」），4096 才够用。
        // 与其猜一个上限，不如放开长度、只靠下面的超时兜底。
      },
      () => {},
      (reasoning) => {
        fullReasoning += reasoning
      },
      { adapterId: model.provider.adapterId, configJson: model.provider.configJson },
      // 画布 LLM 节点超时放宽到 150s：慢推理模型 + 读图场景下 60s 不够用
      // （实测同一请求 7s / 15s / 42s 波动，60s 会随机截断成「This operation was aborted」）
      CHAT_NODE_TIMEOUT_MS,
      ctx.userId,
    ).then((result) => ({ ...result, fullReasoning }))
  }

  const toOutput = (result: Awaited<ReturnType<typeof runUpstream>>) => {
    // 上游只回了思维链、没回正文（推理模型被 max_tokens 截断时的典型表现）：
    // 直接在这里报清楚，避免下游生图节点抛「提示词不能为空」这种指向不明的错。
    if (!String(result.content || '').trim()) {
      throw new Error(
        'LLM 未返回正文内容（可能被上游输出长度上限截断）。请重试，或在供应商管理里为该模型调大 max_tokens。',
      )
    }
    const output: Record<string, unknown> = {
      text: result.content,
      tokens: result.totalTokens,
    }
    if (result.fullReasoning) output.reasoning = result.fullReasoning
    return output
  }

  // Auto-LLM：按 Agent 全局配置的主模型 → 替补链依次尝试，成功后才按实际模型计费。
  if (isAutoLlm(modelId)) {
    const candidates = (await ctx.findModelCandidates?.('TEXT'))?.filter((m) => !!m.provider.apiKey) ?? []
    if (candidates.length === 0) {
      const only = await ctx.findModel('TEXT', undefined)
      if (only?.provider.apiKey) candidates.push(only)
    }
    if (candidates.length === 0) {
      throw new Error('Auto-LLM 没有可用模型，请在系统设置中配置 Auto-LLM 或启用文本模型')
    }
    let lastError: unknown = null
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]
      let output: Record<string, unknown>
      try {
        if (index > 0) {
          await ctx.emit({
            type: 'nodeProgress',
            nodeId: node.id,
            message: `Auto-LLM 主模型不可用，正在切换到 ${candidate.modelName}...`,
          })
        }
        output = toOutput(await runUpstream(candidate, { prompt, images }))
      } catch (error) {
        lastError = error
        continue
      }
      await ctx.deductPoints(candidate.costPoints, `LLM 对话 · ${candidate.modelName}`, candidate)
      return output
    }
    throw lastError instanceof Error ? lastError : new Error('Auto-LLM 全部模型调用失败')
  }

  // 指定模型：保持既有语义（先计费、再请求）。
  const model = await ctx.findModel('TEXT', modelId)
  if (!model) {
    throw new Error('没有可用的文本模型，请在系统设置中配置')
  }
  await ctx.deductPoints(model.costPoints, `LLM 对话 · ${model.modelName}`, model)
  return toOutput(await runUpstream(model, { prompt, images }))
}

function executeCondition(
  _node: ExecutionNode,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const value = String(inputs.value || '')
  const operator = String(inputs.operator || 'equals')
  const compareTo = String(inputs.compareTo || '')

  let result = false
  switch (operator) {
    case 'equals':
      result = value === compareTo
      break
    case 'contains':
      result = value.includes(compareTo)
      break
    case 'greaterThan':
      result = Number(value) > Number(compareTo)
      break
    case 'lessThan':
      result = Number(value) < Number(compareTo)
      break
    default:
      result = value === compareTo
  }

  return { result }
}


function executeTextConcat(inputs: Record<string, unknown>): Record<string, unknown> {
  const textA = String(inputs.textA ?? '')
  const textB = String(inputs.textB ?? '')
  const sep = String(inputs.separator ?? '\n')
  return { result: [textA, textB].filter(Boolean).join(sep) }
}

function executeNumberCalc(inputs: Record<string, unknown>): Record<string, unknown> {
  const a = Number(inputs.a) || 0
  const b = Number(inputs.b) || 0
  const operator = String(inputs.operator || 'add')
  let result = 0
  switch (operator) {
    case 'add':
      result = a + b
      break
    case 'subtract':
      result = a - b
      break
    case 'multiply':
      result = a * b
      break
    case 'divide':
      result = b === 0 ? 0 : a / b
      break
    default:
      result = a + b
  }
  return { result }
}

async function executeImageGenerate(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  // 提示词原样透传：@图N 旧版语法已废弃，参考图通过 referenceImage 端口连线按序传入，
  // 用户在提示词里用「第一张图/第二张图…」自然语言指代（各模型理解一致，无特殊语法）。
  // 主体提示词（每个方向各自的描述）
  const promptBase = String(inputs.prompt || '').trim()
  // 共享补充要求（产品信息 / 卖点 / 文案语言等）：由工具作者用文本节点接到 promptSuffix 口，
  // 让 N 个方向共用同一段要求，而不必把每个方向的提示词都复制一遍。
  const promptSuffix = String(inputs.promptSuffix || '').trim()
  const prompt = promptSuffix ? `${promptBase}\n\n${promptSuffix}`.trim() : promptBase
  if (!promptBase) {
    throw new Error('图像生成节点的提示词不能为空')
  }

  const negativePrompt = String(inputs.negativePrompt || '')
  let width = Number(inputs.width ?? 1024)
  let height = Number(inputs.height ?? 1024)
  const modelId = inputs.model ? String(inputs.model) : undefined
  // 参考图(动态端口:仅模型支持参考图时存在;可为单张字符串或数组,multiReference 模型一次传多张)
  // 防御:只保留有效 http(s) 链接或 data:image 地址,丢弃 {{...}} 模板占位等垃圾值,避免生成失败
  const refInput = inputs.referenceImage
  const rawRefs = (Array.isArray(refInput)
    ? refInput.map(String)
    : (typeof refInput === 'string' && refInput ? [refInput] : []))
    .filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
  // 额外收集 inputs.image（与 LLM 节点对齐：连线即引用，image 口也收图）
  const imageInput = inputs.image
  const extraImgs = Array.isArray(imageInput)
    ? imageInput.map(String).filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
    : (typeof imageInput === 'string' && imageInput ? [imageInput] : [])
  // 跨端口去重后再拼接（2026-10-10 生产事故：「图生图」工具把同一个上传源同时接到
  // image + referenceImage 两个口，两口各 11 张、内容完全相同，拼接后 22 张超过
  // 上游 16 张上限 → 400。resolveInputs 只对同端口连线去重，跨端口的重复必须在这里收口）。
  const allRefs = Array.from(new Set([...rawRefs, ...extraImgs]))
  // base64 参考图落地为 URL 再传上游（部分上游不接受 data URL 或体积超限）
  // 参考图统一转成上游可读地址。
  // 因为上游远端 API 需要 fetch 图片，data URL 在 JSON 里只会被当作无意义字符串。
  // 这里强制走 persistDataUrl（落盘成 /api/asset/...）再拼 PUBLIC_BASE_URL，
  // 跳过 toUpstreamImageUrl 的内联 data URL 逻辑。
  const referenceImages = await Promise.all(allRefs.map(async (v) => {
    if (v.startsWith('data:image/')) {
      const persisted = await persistDataUrl(v, ctx.userId)
      if (persisted.startsWith('/api/asset/') || persisted.startsWith('/generated/')) {
        return `${PUBLIC_BASE_URL}${persisted}`
      }
      // 落盘失败 persistDataUrl 会抛错（不再返回 data URL）；走到这里说明返回了
      // 非站内值（如非法 data URL 原样回传）——绝不能把 data URL 交给只认公网 URL 的上游。
      throw new Error('参考图保存失败（服务器磁盘/配额原因），请重试或换一张图。')
    }
    if (v.startsWith('/api/asset/') || v.startsWith('/generated/')) {
      // 站内素材要先确认文件还在：上传素材只保留 2 小时，过期后会被清理任务删除，
      // 而 seedOutputs 里仍留着旧路径（重跑时就会带着失效地址）。
      // 不检查的话上游只会回「image_url fetch failed: HTTP 404」，用户不知道该重传。
      if (!(await isLocalAssetAlive(v))) {
        throw new Error(EXPIRED_ASSET_MESSAGE)
      }
      return `${PUBLIC_BASE_URL}${v}`
    }
    return v // 已是公网 URL
  }))

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '选择图像模型...' })

  // 优先用节点选的 modelId，否则按 IMAGE 兜底
  const model = await ctx.findModel('IMAGE', modelId)
  if (!model) {
    throw new Error('没有可用的图像生成模型，请在系统设置中配置')
  }

  // 尺寸校验:优先用 metadata.sizes(支持「比例@档位」新格式与「宽x高」旧格式),没配则调上游 /models 获取
  const modelMeta = (model as { metadata?: Record<string, unknown> }).metadata
  let sizes = Array.isArray(modelMeta?.sizes) ? (modelMeta.sizes as string[]) : []
  if (sizes.length === 0) {
    // 走 provider-invoker（adapter 鉴权头 + 统一超时/错误翻译），不再裸 fetch
    sizes = await fetchModelSizes(
      { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, adapterId: model.provider.adapterId, configJson: model.provider.configJson as Record<string, unknown> | null },
      model.modelName,
    )
  }
  // 档位差价:按节点实际选中的档位取价（未单独定价的档位沿用 1K 参考价）
  const selected = decodeSize(`${width}x${height}`)
  const modelBilling = { costPoints: model.costPoints, discount: activeDiscount(model), isFree: model.isFree, metadata: modelMeta ?? null }
  let costPoints = resolveTierCost(modelBilling, selected?.tier)
  // 尺寸可能被下面的「吸附到预设列表」逻辑校正，档位随之变化。
  // 免费额度上限（freeQuotaMaxTier）必须用**最终**档位判定，所以这里跟着更新。
  let chargeTier = selected?.tier
  if (sizes.length > 0) {
    // 预设列表解码成像素尺寸再比对(新格式 ratio@tier / 旧格式 宽x高 都兼容)
    const pixelSizes = sizes
      .map((s) => {
        const d = decodeSize(s)
        return d ? `${d.width}x${d.height}` : (/^\d+x\d+$/.test(s) ? s : null)
      })
      .filter((s): s is string => !!s)
    if (pixelSizes.length > 0 && !pixelSizes.includes(width + 'x' + height)) {
      // 不在预设列表中：先按宽高比过滤（±10% 容差，保住用户选的比例），同比例内按面积差最小
      const targetArea = width * height
      const targetRatio = width / height
      const cands = pixelSizes
        .map((s) => {
          const [sw, sh] = s.split('x').map(Number)
          return { sw, sh, diff: Math.abs(sw * sh - targetArea) }
        })
        .filter((c) => c.sw && c.sh)
      const ratioOk = cands.filter((c) => Math.abs(c.sw / c.sh - targetRatio) / targetRatio <= 0.1)
      const pool = ratioOk.length > 0 ? ratioOk : cands // 没有同比例候选才退回全列表
      let best = pool[0]
      for (const c of pool) if (c.diff < best.diff) best = c
      width = best.sw
      height = best.sh
      // 尺寸被校正后档位可能变化,重取档位价
      const corrected = decodeSize(`${width}x${height}`)
      costPoints = resolveTierCost(modelBilling, corrected?.tier)
      chargeTier = corrected?.tier
    }
  }

  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除积分...' })
  // 档位价统一过 effectivePoints（折扣/免费，保留 2 位小数），与顶层预算口径一致
  const nodeCost = effectivePoints(costPoints, activeDiscount(model), model.isFree)
  await ctx.deductPoints(nodeCost, `生成图片 · ${model.modelName}`, model, chargeTier)

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '生成图像中...' })

  const { imageUrl } = await generateImage({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    prompt,
    negativePrompt,
    width,
    height,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    userId: ctx.userId,
    adapterId: model.provider.adapterId,
    configJson: model.provider.configJson,
    modelMetadata: (model.metadata as Record<string, unknown> | null) ?? null,
  })

  return { imageUrl }
}

/**
 * 九宫格循环帧：结构化输入 → 统一提示词 → 复用生图执行器。
 *
 * 刻意不复制 executeImageGenerate 的模型选择 / 尺寸吸附 / 扣费逻辑：
 * 九宫格只是「提示词形态」，生图链路（adapter、计费、资产落盘）必须与
 * 普通生图完全同源，否则又会出现「同一个模型、两套扣费口径」的历史问题。
 */
async function executeNineGridLoop(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  // 参考图可能从 referenceImage 或 image 两个口进来（与 executeImageGenerate 同口径）。
  // 不能写成 `referenceImage ?? image`：空数组不是 null，会把后面的有效 image 遮掉。
  const hasReference = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some((item) => typeof item === 'string' && item)
      : typeof value === 'string' && value.length > 0
  if (!hasReference(inputs.referenceImage) && !hasReference(inputs.image)) {
    throw new Error('九宫格循环帧需要一张角色参考图：请连接图片上传节点，或先在参考图端口上传图片')
  }

  // 单文本框分镜脚本优先；旧画布里按四个独立字段创建的节点继续可用（兼容回退）。
  // 脚本没有【角色】【场景】【动作】任何小节时，走「自由描述」模式：
  // 用户只写了一句话/一段 prompt，也照样能出宫格，不让它卡在格式校验上。
  const script = String(inputs.script ?? '').trim()
  const grid = inputs.grid
  const outputMode = normalizeOutputMode(inputs.outputMode)
  let promptInput: Parameters<typeof buildNineGridLoopPrompt>[0]
  if (script) {
    const parsed = parseNineGridScript(script)
    const structured = Boolean(parsed.character || parsed.scene || parsed.actions)
    promptInput = structured
      ? { ...parsed, grid }
      : {
        // 直出分支的脚本 = 描述 + 「画风：…」+「宫格：…」；
        // 后两行由 style/grid 参数单独表达，不当作创作描述再喂一遍。
        brief: script
          .split(/\r?\n/)
          .filter((line) => !/^\s*(画风|风格|宫格|宫格规格)\s*[:：]/.test(line))
          .join('\n')
          .trim() || script,
        style: parsed.style,
        grid,
      }
  } else {
    promptInput = {
      character: String(inputs.character ?? ''),
      scene: String(inputs.scene ?? ''),
      actions: String(inputs.actions ?? ''),
      style: String(inputs.style ?? ''),
      grid,
    }
  }
  const prompt = outputMode === 'native-gif'
    ? buildNativeGifPrompt(promptInput)
    : buildNineGridLoopPrompt(promptInput)

  const output = await executeImageGenerate(
    node,
    {
      ...inputs,
      prompt,
      negativePrompt:
        String(inputs.negativePrompt ?? '').trim() || NINE_GRID_LOOP_DEFAULT_NEGATIVE_PROMPT,
      width: Number(inputs.width) || 1024,
      height: Number(inputs.height) || 1024,
    },
    ctx,
  )
  // 只在「明确是静态图扩展名」时拦截；有些上游 GIF 地址不带扩展名，
  // 不能因为 URL 里没有 .gif 就误判失败。
  const url = String(output.imageUrl ?? '')
  if (outputMode === 'native-gif' && /\.(png|jpe?g|webp)(?:$|[?#])/i.test(url)) {
    throw new Error('所选生图模型没有返回 GIF。请选择原生支持 GIF 的模型，或改用宫格合成模式。')
  }
  return output
}

/**
 * 九宫格大图 → 循环 GIF。
 *
 * 不调用任何模型、不扣积分：切分和编码都在服务端用 sharp/cgif 完成。
 * 这样「生图工具」一次运行就能同时拿到九宫格图和可直接下载的动图。
 */
async function executeGrid9ToGif(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const imageUrl = String(inputs.imageUrl ?? '').trim()
  if (!imageUrl) throw new Error('九宫格转GIF需要一张九宫格大图：请连接九宫格循环帧节点')

  // 原生 GIF 模式：上游模型已经直接产出 animated GIF，这里只透传，不能再切格。
  if (await isGifSource(imageUrl)) {
    return {
      gifUrl: imageUrl,
      frameUrls: [],
      frameCount: 0,
      nativeGif: true,
    }
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '切分宫格并合成 GIF...' })
  const grid = normalizeGrid(inputs.grid)
  const result = await createGridGif(imageUrl, {
    grid,
    delayMs: Number(inputs.delayMs),
    mode: String(inputs.mode ?? 'normal'),
    frames: String(inputs.frames ?? '1-9'),
    trimPercent: Number(inputs.trimPercent),
    maxSize: Number(inputs.maxSize),
    background: String(inputs.background ?? '#ffffff'),
  })
  if (result.gif.byteLength > ASSET_MAX_SIZE) {
    throw new Error('生成的 GIF 超过 10MB：请降低「单帧最长边」，或减少帧数后重试')
  }

  // GIF + 每帧 PNG 都登记进 user_assets：否则只落盘不登记，TTL/配额都失效。
  const gifAsset = await saveAssetWithRecord(ctx.prisma, ctx.userId, result.gif, {
    mime: 'image/gif',
    type: 'image',
    source: 'generated',
  })
  // 调速要在之后重新切帧：上游外链可能几小时就失效，先存一份站内稳定副本。
  let sourceImageUrl = imageUrl
  if (!(imageUrl.startsWith('/api/asset/') || imageUrl.startsWith('/generated/'))) {
    const savedSource = await saveAssetWithRecord(ctx.prisma, ctx.userId, result.sourceImage, {
      mime: result.sourceMime,
      type: 'image',
      source: 'canvas',
    })
    sourceImageUrl = savedSource.url
  }
  const frameAssets: Array<{ url: string }> = []
  for (const frame of result.frames) {
    // 顺序写入，避免 SQLite 并发写互相抢锁
    frameAssets.push(await saveAssetWithRecord(ctx.prisma, ctx.userId, frame, {
      mime: 'image/png',
      type: 'image',
      // 帧是中间产物：保留 2 小时供同一次工作流/下载使用，避免每次运行永久堆 9 条
      source: 'canvas',
    }))
  }

  return {
    gifUrl: gifAsset.url,
    frameUrls: frameAssets.map((asset) => asset.url),
    frameCount: result.frameCount,
    width: result.width,
    height: result.height,
    delayMs: result.delayMs,
    // 供成果区「调速」重新合成时复用（不进结果区，只有 gifUrl 会展示）
    sourceImageUrl,
    grid,
    frames: String(inputs.frames ?? `1-${gridFrameCount(grid)}`),
    mode: String(inputs.mode ?? 'normal'),
    trimPercent: Number(inputs.trimPercent ?? 1),
    maxSize: Number(inputs.maxSize ?? 512),
    background: String(inputs.background ?? '#ffffff'),
  }
}

async function executeVideoGenerate(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const prompt = String(inputs.prompt || '')
  if (!prompt) {
    throw new Error('视频生成节点的提示词不能为空')
  }

  const negativePrompt = String(inputs.negativePrompt || '')
  const width = Number(inputs.width ?? 1280)
  const height = Number(inputs.height ?? 720)
  const duration = inputs.duration != null ? Number(inputs.duration) : undefined
  const aspectRatio = inputs.aspectRatio ? String(inputs.aspectRatio) : undefined
  const resolutionRaw = inputs.resolution ? String(inputs.resolution) : undefined
  const resolution = resolutionRaw ? normalizeVideoResolution(resolutionRaw) : undefined
  const firstFrame = inputs.firstFrame ? await persistForUpstream(String(inputs.firstFrame), ctx.userId) : undefined
  const lastFrame = inputs.lastFrame ? await persistForUpstream(String(inputs.lastFrame), ctx.userId) : undefined
  // 与参考图同口径：过滤模板占位值 → 落盘成公网 URL（上游只认公网地址）→ 经 extras 透传 adapter。
  const asUrlList = (v: unknown, kindRe: RegExp) => (Array.isArray(v) ? v.map(String) : (typeof v === 'string' && v ? [v] : []))
    .filter((u) => kindRe.test(u))
  const rawRefVideos = asUrlList(inputs.referenceVideo, /^(https?:\/\/|data:video\/|\/api\/asset\/|\/generated\/)/i)
  const rawRefAudios = asUrlList(inputs.referenceAudio, /^(https?:\/\/|data:audio\/|\/api\/asset\/|\/generated\/)/i)
  const [referenceVideos, referenceAudios] = await Promise.all([
    // 音视频**永不内联 base64**（体积大 + MIME 不对），只补公网地址 —— 见 toUpstreamMediaUrl。
    rawRefVideos.length > 0 ? Promise.all(rawRefVideos.map((u) => toUpstreamMediaUrl(u))) : Promise.resolve(undefined),
    rawRefAudios.length > 0 ? Promise.all(rawRefAudios.map((u) => toUpstreamMediaUrl(u))) : Promise.resolve(undefined),
  ])
  const modelId = inputs.model ? String(inputs.model) : undefined

  // 与生图节点同口径——收集 referenceImage / image 端口连进来的图，
  // 去掉模板占位等垃圾值，data URL 落盘成公网 URL（上游只认公网地址）。
  const refInput = inputs.referenceImage
  const rawRefs = (Array.isArray(refInput) ? refInput.map(String) : (typeof refInput === 'string' && refInput ? [refInput] : []))
    .filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
  const imageInput = inputs.image
  const extraImgs = (Array.isArray(imageInput) ? imageInput.map(String) : (typeof imageInput === 'string' && imageInput ? [imageInput] : []))
    .filter((v) => /^(https?:\/\/|data:image\/|\/api\/asset\/|\/generated\/)/i.test(v))
  // 跨端口去重：与生图节点同口径（同一源可能被同时接到 image + referenceImage 两个口）
  const allRefs = Array.from(new Set([...rawRefs, ...extraImgs]))
  const referenceImages = allRefs.length > 0 ? await Promise.all(allRefs.map((v) => persistForUpstream(v, ctx.userId))) : undefined

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '选择视频模型...' })

  const model = await ctx.findModel('VIDEO', modelId)
  if (!model) {
    throw new Error('没有可用的视频生成模型，请在系统设置中配置')
  }

  // 能力约束**提交上游之前**校验（与 /api/video/generate 同口径）。
  //
  // 甚至字段名都不同：首尾帧只吃 first_frame/last_frame、动作迁移只吃 ref_image/ref_video）。
  // 不校验的话，给「首尾帧工作流」连 3 张参考图照样提交 → 上游报错 → **豆已经扣了**。
  // 这类「参数非法但先扣费」的账，只能靠提交前拦住。
  const constraintErr = validateVideoParams(model as never, {
    duration,
    resolution,
    ratio: aspectRatio,
    // ⚠️ firstFrame / lastFrame **也是图**，必须一起计入（2026-10-18 修）：
    //   referenceImages 恒为空 → imageCount 恒为 0 → 撞上它的 `maxImages: 0`
    //   于是每次都报「最多 0 张参考图」，这个工作流**从来就没能跑通过**。
    imageCount: (referenceImages?.length ?? 0) + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0),
    audioCount: referenceAudios ? referenceAudios.length : 0,
    videoCount: referenceVideos ? referenceVideos.length : 0,
  })
  if (constraintErr) throw new Error(constraintErr)

  // 视频用豆计价：统一走 planNodeCharge（与预扣预算、charge-run 同口径）。
  // 优先按秒（metadata.perSecondBeans × duration），未配/无时长则回退 videoCost 一口价。
  // 计费因子统一走 nodeChargeInputs（同 mcp/executor 预扣口径），只覆盖「上游实收张数」——
  // referenceImage + image 两口去重后的真实张数，预扣按节点 inputs 估算，这里按实际提交数结算。
  const beansCost = planNodeCharge('VIDEO', model, {
    ...nodeChargeInputs(inputs),
    // 预扣按节点 inputs 估算输入张数；这里必须按实际提交给上游的去重后张数结算，
    // 否则跨端口同一张图会被算两次（与 executeImageGenerate 的去重口径一致）。
    imageCount: referenceImages ? referenceImages.length : 0,
  }).beans
  if (beansCost <= 0) {
    throw new Error('该视频模型未配置豆价，请联系管理员')
  }

  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除豆...' })
  await ctx.deductBeans(beansCost, `生成视频 · ${model.modelName}`, model)

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '生成视频中（可能需要几分钟）...' })

  const result = await generateVideo({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    prompt,
    negativePrompt,
    width,
    height,
    duration,
    aspectRatio,
    resolution,
    firstFrame,
    lastFrame,
    referenceImages,
    // extras 是 adapter 的厂商特有参数通道：参考视频/音频按各自的字段名透传
    ...(referenceVideos || referenceAudios
      ? { extras: { ...(referenceVideos ? { referenceVideos } : {}), ...(referenceAudios ? { referenceAudios } : {}) } }
      : {}),
    userId: ctx.userId,
    adapterId: model.provider.adapterId,
    configJson: model.provider.configJson,
    modelMetadata: (model.metadata as Record<string, unknown> | null) ?? null,
  })

  // 同步路径：直接拿到视频
  if (result.videoUrl) {
    return { videoUrl: result.videoUrl }
  }

  // 异步路径：轮询上游任务
  if (result.taskId) {
    await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '等待视频任务完成...' })
    const provider = { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, adapterId: model.provider.adapterId, configJson: model.provider.configJson }
    // 旧实现写死 120×5s = 10 分钟 → 慢模型**必然**在上游还在跑时就判超时并退豆，
    // 用户看到「视频生成超时」但上游其实成功了（钱已扣、成品拿不到）。
    // 改成时间预算 30 分钟（覆盖排队 + 生成），退化为「超时才失败」而不是「稍慢就失败」。
    const POLL_INTERVAL_MS = 5000
    const POLL_BUDGET_MS = 30 * 60 * 1000
    const deadline = Date.now() + POLL_BUDGET_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const status = await queryVideoStatus(provider, result.taskId, result.pollPath)
      if (status.status === 'SUCCESS' && status.videoUrl) {
        return { videoUrl: status.videoUrl }
      }
      if (status.status === 'FAILED') {
        throw new Error(status.error || '视频生成失败')
      }
    }
    throw new Error('视频生成超时（已等待 30 分钟），请稍后重试或选择更快的模型')
  }

  throw new Error('上游未返回视频数据')
}

async function executeAudioGenerate(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const prompt = String(inputs.prompt || '')
  if (!prompt) {
    throw new Error('音频生成节点的内容不能为空')
  }

  const lyrics = inputs.lyrics ? String(inputs.lyrics) : undefined
  const voiceId = inputs.voiceId ? String(inputs.voiceId) : undefined
  const modelId = inputs.model ? String(inputs.model) : undefined
  // 指定时长的音频（音效/音乐等）可按时长计费；无 duration 或未配 perSecondCost 则回退按次
  const durationSec = inputs.duration != null && Number(inputs.duration) > 0 ? Number(inputs.duration) : undefined

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '选择音频模型...' })

  const model = await ctx.findModel('AUDIO', modelId)
  if (!model) {
    throw new Error('没有可用的音频生成模型，请在系统设置中配置')
  }

  // 音频计价：优先按秒（metadata.perSecondCost × duration），指定了时长且配了单价才应用；否则按次 costPoints
  const perSec = durationSec != null ? resolvePerSecondPoints(model, durationSec) : null
  const costPoints = perSec ?? effectivePoints(model.costPoints || 0, activeDiscount(model), model.isFree)
  if (costPoints <= 0 && !model.isFree) {
    throw new Error('该音频模型未配置积分，请联系管理员')
  }

  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除积分...' })
  if (costPoints > 0) {
    await ctx.deductPoints(costPoints, `生成音频 · ${model.modelName}`, model)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '生成音频中（可能需要数十秒）...' })

  const result = await generateAudio({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    userId: ctx.userId,
    adapterId: model.provider.adapterId,
    configJson: model.provider.configJson,
    modelMetadata: (model.metadata as Record<string, unknown> | null) ?? null,
    prompt,
    lyrics,
    voiceId,
    extras: node.type === 'music-generate' ? { kind: 'music' } : node.type === 'tts-generate' ? { kind: 'tts' } : undefined,
  })

  // 同步路径：直接拿到音频
  if (result.audioUrl) {
    return { audioUrl: result.audioUrl }
  }

  // 异步路径：轮询上游任务（GMI 音乐/配音为 request_id 轮询）
  if (result.taskId) {
    await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '等待音频任务完成...' })
    const provider = { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, adapterId: model.provider.adapterId, configJson: model.provider.configJson }
    // 同视频：按时间预算（音乐类上游排队也常有十几分钟），不再写死轮次
    const POLL_INTERVAL_MS = 5000
    const POLL_BUDGET_MS = 20 * 60 * 1000
    const deadline = Date.now() + POLL_BUDGET_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const status = await queryAudioStatus(provider, result.taskId, result.pollPath)
      if (status.status === 'SUCCESS' && status.audioUrl) {
        return { audioUrl: status.audioUrl }
      }
      if (status.status === 'FAILED') {
        throw new Error(status.error || '音频生成失败')
      }
    }
    throw new Error('音频生成超时（已等待 20 分钟），请稍后重试')
  }

  throw new Error('上游未返回音频数据')
}

// 音效生成：文本描述 → 1-4 个短音效变体（同步接口，取第一个成功变体；全量变体挂在 audioUrls）
async function executeSfxGenerate(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const prompt = String(inputs.prompt || '')
  if (!prompt) {
    throw new Error('音效生成节点的描述不能为空')
  }
  const duration = inputs.duration != null && Number(inputs.duration) > 0 ? Number(inputs.duration) : undefined
  const modelId = inputs.model ? String(inputs.model) : undefined

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '选择音效模型...' })
  const model = await ctx.findModel('AUDIO', modelId)
  if (!model) {
    throw new Error('没有可用的音效模型，请在系统设置中配置')
  }
  const costPoints = effectivePoints(model.costPoints || 0, activeDiscount(model), model.isFree)
  if (costPoints <= 0 && !model.isFree) {
    throw new Error('该音效模型未配置积分，请联系管理员')
  }
  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除积分...' })
  if (costPoints > 0) {
    await ctx.deductPoints(costPoints, `生成音效 · ${model.modelName}`, model)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '生成音效中...' })
  const result = await generateAudio({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    userId: ctx.userId,
    adapterId: model.provider.adapterId,
    configJson: model.provider.configJson,
    modelMetadata: (model.metadata as Record<string, unknown> | null) ?? null,
    prompt,
    duration,
    extras: { kind: 'sfx' },
  })
  if (!result.audioUrl) {
    throw new Error('上游未返回音效数据')
  }
  return { audioUrl: result.audioUrl }
}

async function executeVoiceIsolate(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  const media = inputs.media ? String(inputs.media) : ''
  if (!media) {
    throw new Error('人声分离节点的音频不能为空')
  }
  const modelId = inputs.model ? String(inputs.model) : undefined

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '选择分离模型...' })
  const model = await ctx.findModel('AUDIO', modelId)
  if (!model) {
    throw new Error('没有可用的人声分离模型，请在系统设置中配置')
  }
  const costPoints = effectivePoints(model.costPoints || 0, activeDiscount(model), model.isFree)
  if (costPoints <= 0 && !model.isFree) {
    throw new Error('该分离模型未配置积分，请联系管理员')
  }
  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除积分...' })
  if (costPoints > 0) {
    await ctx.deductPoints(costPoints, `人声分离 · ${model.modelName}`, model)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '人声分离中（整段音频可能需要一些时间）...' })
  const audioUrl = await isolateVoice({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    fileUrl: media,
    path: (model.provider.configJson as Record<string, unknown> | null)?.isolationPath as string | undefined,
  })

  return { audioUrl }
}

// 感知节点：语音识别(ASR) / 文字识别(OCR)。识别媒体文件为文本，按次扣积分。
async function executePerception(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext,
  kind: 'asr' | 'ocr'
): Promise<Record<string, unknown>> {
  const media = inputs.media ? String(inputs.media) : ''
  if (!media) {
    throw new Error(kind === 'asr' ? '语音识别节点的音频不能为空' : '文字识别节点的图片不能为空')
  }
  const modelId = inputs.model ? String(inputs.model) : undefined

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: kind === 'asr' ? '选择识别模型...' : '选择识别模型...' })

  const modelType = kind === 'asr' ? 'AUDIO' : 'VISION'
  const model = await ctx.findModel(modelType, modelId)
  if (!model) {
    throw new Error('没有可用的识别模型，请在系统设置中配置')
  }

  const cost = effectivePoints(model.costPoints || 0, activeDiscount(model), model.isFree)
  if (cost <= 0 && !model.isFree) {
    throw new Error('该识别模型未配置积分，请联系管理员')
  }
  if (!model.provider.apiKey) {
    throw new Error(`Provider ${model.provider.baseUrl} 未配置 API Key`)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '扣除积分...' })
  if (cost > 0) {
    await ctx.deductPoints(cost, `识别 · ${model.modelName}`, model)
  }

  await ctx.emit({ type: 'nodeProgress', nodeId: node.id, message: '识别中...' })
  const text = await runPerception({
    baseUrl: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
    modelName: model.modelName,
    fileUrl: media,
    kind,
    asrPath: (model.provider.configJson as Record<string, unknown> | null | undefined)?.asrPath as string | undefined,
    // OCR 走 invokeChat，需要 adapterId 才能拿到厂商一致的鉴权头与响应解析
    adapterId: model.provider.adapterId ?? null,
    userId: ctx.userId,
  })

  return { text }
}

// 自定义节点执行：沙箱执行 codeSchema(与 adapter 沙箱一致)
async function executeCustomNode(
  node: ExecutionNode,
  inputs: Record<string, unknown>,
  ctx: NodeContext
): Promise<Record<string, unknown>> {
  if (process.env.APP_ENABLE_TRUSTED_CODE !== '1') throw new Error('自定义节点代码未启用')
  const spec = await ctx.getNodeSpec(node.type)
  if (!spec || !spec.codeSchema) {
    throw new Error(`未找到自定义节点 ${node.type} 的代码定义`)
  }

  // 注入工具(白名单沙箱,与 adapter-runtime 一致)
  const sandbox = Object.freeze({
    callLLM: Object.freeze(async (params: { prompt?: string; systemPrompt?: string; model?: string; temperature?: number; images?: string[] }) => {
      const prompt = String(params?.prompt || '')
      if (!prompt) throw new Error('callLLM 缺少 prompt')
      const model = await ctx.findModel('TEXT', params.model)
      if (!model) throw new Error('没有可用的文本模型')
      if (!model.provider.apiKey) throw new Error('Provider 未配置 API Key')
      await ctx.deductPoints(model.costPoints, `LLM 对话 · ${model.modelName}`, model)
      let reasoning = ''
      const result = await streamChatToUpstream(
        model.provider.baseUrl, model.provider.apiKey, model.modelName,
        { systemPrompt: params.systemPrompt, messages: [{ role: 'user', content: prompt }], temperature: params.temperature ?? 0.7, supportsVision: model.supportsVision || model.type === 'VISION', images: params.images, modelMetadata: model.metadata },
        () => {}, (r) => { reasoning += r },
        { adapterId: model.provider.adapterId, configJson: model.provider.configJson },
        undefined,
        ctx.userId,
      )
      return { content: result.content, usage: { totalTokens: result.totalTokens }, reasoning: reasoning || undefined }
    }),
    generateImage: Object.freeze(async (params: { prompt?: string; negativePrompt?: string; width?: number; height?: number; model?: string }) => {
      const prompt = String(params?.prompt || '')
      if (!prompt) throw new Error('generateImage 缺少 prompt')
      const model = await ctx.findModel('IMAGE', params.model)
      if (!model) throw new Error('没有可用的图像模型')
      if (!model.provider.apiKey) throw new Error('Provider 未配置 API Key')
      await ctx.deductPoints(model.costPoints, `生成图片 · ${model.modelName}`, model)
      const result = await generateImage({
        baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, modelName: model.modelName,
        prompt, negativePrompt: params.negativePrompt, width: params.width, height: params.height, userId: ctx.userId,
        adapterId: model.provider.adapterId, configJson: model.provider.configJson,
        modelMetadata: (model.metadata as Record<string, unknown> | null) ?? null,
      })
      return { imageUrl: result.imageUrl }
    }),
    JSON: Object.freeze(JSON),
    Math: Object.freeze(Math),
    Date,
    console: Object.freeze({ log: (...args: unknown[]) => ctx.emit({ type: 'nodeOutput', nodeId: node.id, output: { log: args.map(String).join(' ') } }) }),
  })

  // 用 vm.runInNewContext 彻底隔绝沙箱,阻止逃逸
  let runFn: ((inputs: Record<string, unknown>) => Promise<unknown>) | null = null
  try {
    const wrapped = `(function(){ "use strict";\n${spec.codeSchema}\n;return typeof run==='function'?run:null; })()`
    const script = new vm.Script(wrapped, { filename: 'node.js' })
    const context = vm.createContext(sandbox)
    runFn = script.runInContext(context, { timeout: 5000 }) as typeof runFn
  } catch (err) {
    throw new Error(`节点代码编译失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof runFn !== 'function') {
    throw new Error('节点代码未定义 async function run(inputs)')
  }

  const execPromise = (runFn as (inputs: Record<string, unknown>) => Promise<unknown>)(inputs)
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('节点执行超时（30s）')), 30000))
  const result = await Promise.race([execPromise, timeoutPromise])

  if (!result || typeof result !== 'object') throw new Error('节点 run 函数必须返回对象')
  return result as Record<string, unknown>
}
