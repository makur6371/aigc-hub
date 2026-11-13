import { getPrisma } from '@/lib/prisma'
import { getAdapter } from '@/lib/adapter-runtime'
import { planningCandidates } from '@/lib/agent-config'
import { isAutoLlm } from '@/lib/auto-llm'

/** 各模型类型对应的 adapter 能力钩子：回退时用它过滤「不支持该能力」的供应商 */
const CAPABILITY_BY_TYPE: Record<string, 'buildChatRequest' | 'buildImageRequest' | 'buildVideoRequest' | 'buildAudioRequest'> = {
  TEXT: 'buildChatRequest',
  VISION: 'buildChatRequest',
  IMAGE: 'buildImageRequest',
  VIDEO: 'buildVideoRequest',
  AUDIO: 'buildAudioRequest',
}

/**
 * 回退选模型：同类型里优先选「provider 已配 API Key + adapter 具备该能力钩子」的模型。
 * 快照里记录的模型可能已被删除/停用，回退到不可用的供应商会让整个流程直接失败。
 */
export async function findFallbackModel(type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION' | 'AUDIO') {
  const prisma = await getPrisma()
  // 回退可接受的模型类型：TEXT 槽位在 UI 上允许选「多模态读图模型」(VISION)，
  // 服务端回退口径必须一致，否则会出现「面板里明明有可用模型，跑起来却说没有可用文本模型」。
  const acceptable: Array<'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION' | 'AUDIO'> =
    type === 'TEXT' ? ['TEXT', 'VISION'] : [type]
  const candidates = await prisma.modelConfig.findMany({
    // provider.isActive 必须一起校验：停用的供应商即使还留着 Key 也不能回退过去，
    // 否则会落到已下线的上游上，报出「403 / 认证失败」这种让人以为是 Key 坏了的错。
    where: { type: { in: acceptable }, isActive: true, provider: { isActive: true, apiKey: { not: '' } } },
    include: { provider: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  if (candidates.length === 0) return null
  const hook = CAPABILITY_BY_TYPE[type] ?? 'buildChatRequest'
  for (const candidate of candidates) {
    if (!candidate.provider) continue
    try {
      const adapter = await getAdapter({ adapterId: candidate.provider.adapterId })
      if (typeof (adapter as unknown as Record<string, unknown>)[hook] === 'function') return candidate
    } catch {
      // adapter 加载失败：跳过该候选，继续找下一个可用模型
    }
  }
  return null
}

export async function findDefaultModel(type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION' | 'AUDIO') {
  const prisma = await getPrisma()
  const acceptable: Array<'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION' | 'AUDIO'> =
    type === 'TEXT' ? ['TEXT', 'VISION'] : [type]
  const candidates = await prisma.modelConfig.findMany({
    where: { type: { in: acceptable }, isActive: true, provider: { isActive: true, apiKey: { not: '' } } },
    include: { provider: true },
    orderBy: { createdAt: 'asc' },
  })
  if (candidates.length === 0) return null
  if (type === 'IMAGE') {
    const withQuota = candidates.find((c) => (c.dailyUserFreeQuota ?? 0) > 0 || c.isFree)
    if (withQuota) return withQuota
  }
  return candidates[0]
}

/**
 * 预扣估算用的模型解析：与执行期（mcp/executor 的 findModel）口径保持一致——
 * 节点指定的模型失效/停用时按类型回退，避免预扣按「第一个激活模型」低估成本、
 * 执行时却落到更贵的模型上导致扣穿。
 */
export async function resolveChargeModel(type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION' | 'AUDIO', modelId?: string) {
  const prisma = await getPrisma()
  // Auto-LLM 的计费锚点必须与执行期同一条候选链，否则预估和实扣会分叉。
  if (isAutoLlm(modelId) && (type === 'TEXT' || type === 'VISION')) {
    const preferred = (await planningCandidates())[0]
    if (preferred) return preferred
  }
  if (modelId) {
    const exact = await prisma.modelConfig.findFirst({ where: { id: modelId, isActive: true } })
    if (exact) return exact
  }
  return findFallbackModel(type)
}

export interface ModelOption {
  id: string
  name: string
  type: string
  supportsVision: boolean
  costPoints: number
  videoCost?: number | null
  isFree: boolean
  isActive: boolean
}

export async function listActiveModels(type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'VISION'): Promise<ModelOption[]> {
  const prisma = await getPrisma()
  const where = type ? { type, isActive: true } : { isActive: true }
  const models = await prisma.modelConfig.findMany({
    where,
    include: { provider: true },
    orderBy: { createdAt: 'asc' },
  })
  return models.map((m) => ({
    id: m.id,
    name: m.modelName || m.name,
    type: m.type,
    supportsVision: m.supportsVision || m.type === 'VISION',
    costPoints: m.costPoints,
    videoCost: m.videoCost,
    isFree: m.isFree,
    isActive: m.isActive,
  }))
}
