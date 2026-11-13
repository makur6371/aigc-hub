import { getPrisma } from '@/lib/prisma'

export interface AgentConfigShape {
  planningModelId: string | null
  /** 规划模型替补链（有序）：主模型失败后按顺序降级。空数组 = 退回默认池 */
  planningBackupModelIds: string[]
}

const DEFAULT_AGENT_CONFIG: AgentConfigShape = { planningModelId: null, planningBackupModelIds: [] }

let cached: AgentConfigShape | null = null

/** 从 DB 记录里安全解析替补 id 数组（Json 列，容错各种脏值） */
export function parseBackupIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** 读取 Agent 全局配置（单例，带内存缓存；后台保存后调用 clearAgentConfigCache 失效） */
export async function getAgentConfig(): Promise<AgentConfigShape> {
  if (cached) return cached
  const prisma = await getPrisma()
  const record = await prisma.agentConfig.findUnique({ where: { id: 'primary' } })
  cached = record
    ? { planningModelId: record.planningModelId, planningBackupModelIds: parseBackupIds(record.planningBackupModelIds) }
    : { ...DEFAULT_AGENT_CONFIG }
  return cached
}

export function clearAgentConfigCache() {
  cached = null
}

/**
 * Auto-LLM 候选链：后台显式配置过（主模型或替补链任一）→ 只按配置顺序；
 * 完全没配置 → 才退回默认池（其余启用的 TEXT/VISION，免费优先）。
 */
export async function planningCandidates() {
  const prisma = await getPrisma()
  const agentCfg = await getAgentConfig()
  const pinnedId = agentCfg.planningModelId || process.env.AGENT_PLANNING_MODEL_ID
  const backupIds = agentCfg.planningBackupModelIds

  const pool = await prisma.modelConfig.findMany({
    where: { type: { in: ['TEXT', 'VISION'] }, isActive: true, provider: { isActive: true } },
    include: { provider: true },
    orderBy: [{ isFree: 'desc' }, { createdAt: 'asc' }],
  })

  const ordered: typeof pool = []
  const seen = new Set<string>()
  const push = (model: (typeof pool)[number] | undefined) => {
    if (!model || seen.has(model.id)) return
    seen.add(model.id)
    ordered.push(model)
  }

  const configured = Boolean(pinnedId) || backupIds.length > 0
  if (configured) {
    if (pinnedId) push(pool.find((model) => model.id === pinnedId))
    for (const id of backupIds) push(pool.find((model) => model.id === id))
  } else {
    for (const model of pool) push(model)
  }
  return ordered
}
