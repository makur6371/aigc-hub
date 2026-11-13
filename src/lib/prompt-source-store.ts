// ===== 提示词源：DB 拉取/播种/状态维护 =====
//
// 与 prompt-sources.ts 的分工：
//   prompt-sources.ts  = 纯逻辑（源定义 / 归一化 / 拉取）
//   本文件             = 把拉取结果幂等写进 DB + 维护源状态
//
// 幂等策略：以 (sourceId, externalId) 为唯一键 upsert。
//   - 新条目 → create
//   - 旧条目 → update（标题/内容/封面/分类可能被上游修订）
//   - 已从上游消失的条目 —— 不删（用户可能已收藏/引用），留着手动清理
// 失败策略：拉取失败只更新 lastStatus/lastError，绝不动已有提示词，
//   因此「上次成功的缓存」天然可用（对齐开源项目的行为）。

import { getPrisma } from '@/lib/prisma'
import {
  BUILTIN_PROMPT_SOURCES,
  fetchPromptSource,
  categoryOf,
  PROMPT_REGISTRY_HOMEPAGE,
  type RawPrompt,
} from '@/lib/prompt-sources'

/** 拉取结果摘要 */
export interface PullResult {
  sourceId: string
  name: string
  ok: boolean
  inserted: number
  updated: number
  skipped: number
  total: number
  error?: string
}

/**
 * 把内置源播种进 DB（幂等）。
 *
 * 只补不改：新增内置源时插入；已存在的按 name/homepage 校正，
 * 但 **不覆盖 url / enabled / cacheCover** —— 管理员可能改过镜像前缀或关过封面缓存，
 * 每次启动都重置会让这些调整失效。
 */
export async function ensureBuiltinPromptSources(): Promise<void> {
  const prisma = await getPrisma()
  for (const def of BUILTIN_PROMPT_SOURCES) {
    const existing = await prisma.promptSource.findFirst({ where: { builtIn: true, name: def.name } })
    if (existing) continue
    await prisma.promptSource.create({
      data: {
        name: def.name,
        url: def.url,
        homepage: def.homepage,
        enabled: true,
        builtIn: true,
        cacheCover: true,
      },
    })
  }
}

/**
 * 拉取单个源并入库。
 *
 * @param sourceId prompt_sources.id
 */
export async function pullPromptSource(sourceId: string): Promise<PullResult> {
  const prisma = await getPrisma()
  const source = await prisma.promptSource.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error('来源不存在')

  const result = await fetchPromptSource(source.url)
  const base: Omit<PullResult, 'ok' | 'inserted' | 'updated' | 'skipped' | 'total'> = {
    sourceId: source.id,
    name: source.name,
  }

  if (!result.ok) {
    await prisma.promptSource.update({
      where: { id: source.id },
      data: { lastStatus: 'FAILED', lastError: result.error.slice(0, 500), lastPulledAt: new Date() },
    })
    return { ...base, ok: false, inserted: 0, updated: 0, skipped: 0, total: 0, error: result.error }
  }

  const { inserted, updated, skipped } = await upsertPromptItems(source.id, result.items)

  await prisma.promptSource.update({
    where: { id: source.id },
    data: {
      lastStatus: 'SUCCESS',
      lastError: null,
      lastCount: result.items.length,
      lastPulledAt: new Date(),
    },
  })

  return { ...base, ok: true, inserted, updated, skipped, total: result.items.length }
}

/** 拉取所有 enabled 的源 */
export async function pullAllPromptSources(): Promise<PullResult[]> {
  const prisma = await getPrisma()
  const sources = await prisma.promptSource.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
  const results: PullResult[] = []
  for (const source of sources) {
    try {
      results.push(await pullPromptSource(source.id))
    } catch (err) {
      results.push({
        sourceId: source.id,
        name: source.name,
        ok: false,
        inserted: 0,
        updated: 0,
        skipped: 0,
        total: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return results
}

/** 幂等写入一批条目，返回计数 */
async function upsertPromptItems(
  sourceId: string,
  items: RawPrompt[]
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const prisma = await getPrisma()
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const item of items) {
    const title = item.title.trim().slice(0, 200)
    const content = item.prompt.trim()
    if (!title || !content) {
      skipped++
      continue
    }
    const data = {
      title,
      content,
      category: categoryOf(item),
      kind: 'creative',
      coverUrl: item.coverUrl || null,
      isPublic: true,
      status: 'APPROVED',
      isOfficial: true,
      creatorId: null,
      sourceUrl: item.sourceUrl || null,
    }

    // 唯一键 upsert：(sourceId, externalId)
    const existing = await prisma.promptTemplate.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: item.externalId } },
      select: { id: true },
    }).catch(() => null)

    if (existing) {
      await prisma.promptTemplate.update({ where: { id: existing.id }, data })
      updated++
    } else {
      await prisma.promptTemplate.create({ data: { ...data, sourceId, externalId: item.externalId } })
      inserted++
    }
  }

  return { inserted, updated, skipped }
}

export { PROMPT_REGISTRY_HOMEPAGE }
