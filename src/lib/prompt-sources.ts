// ===== 提示词源：注册表 + 归一化 + 拉取 =====
//
// 背景：此前「拉提示词」是一条硬编码通道（scripts/seed-prompts.ts 固定拉 VOZEB），
// 多源后无法回答「这条来自哪、要不要重拉、上次成功没」。本模块把这件事收敛成
// 一条统一链路，对齐 basketikun/infinite-canvas 的做法：
//
//   源(url) ──fetch──▶ 标准 JSON 数组 ──normalize──▶ RawPrompt[] ──upsert──▶ prompt_templates
//
// 关键设计：
//   1) 源只是配置（name/url/homepage/enabled），解析逻辑只有一份 —— 新增源 = 加一行 URL。
//   2) 标准 JSON 的 schema 与 yukkcat/image-prompts 注册表一致，因此可直接复用它的 dist。
//   3) 国内可达性：GitHub raw / jsdelivr 常被墙，故对每个 URL 生成镜像候选，
//      按顺序尝试直到成功（第一个可用的即返回）。这是「国内能拉到」的关键。
//   4) 拉取是纯函数式归一 + 幂等 upsert，失败不破坏已有数据（见 pull 逻辑）。

import { safeFetch } from '@/lib/ssrf-guard'

/** 归一化后的提示词条目（入库前的中间形态） */
export interface RawPrompt {
  externalId: string
  title: string
  prompt: string
  description: string
  coverUrl: string
  tags: string[]
  author: string
  sourceUrl: string
  createdAt: string
}

/** 内置源定义（与 yukkcat/image-prompts 注册表一一对应） */
export interface BuiltinPromptSource {
  key: string
  name: string
  homepage: string
  /** 标准 JSON 地址（注册表 dist）；镜像候选在 mirrorCandidates 里按序生成 */
  url: string
}

export const BUILTIN_PROMPT_SOURCES: BuiltinPromptSource[] = []
export const PROMPT_REGISTRY_HOMEPAGE = ''

const MIRROR_PREFIXES = ['']

/** 把一个 URL 展开成「原址 + 各镜像」的候选列表（去重、保持顺序） */
export function mirrorCandidates(url: string): string[] {
  const out: string[] = []
  for (const prefix of MIRROR_PREFIXES) {
    const candidate = prefix ? prefix + url : url
    if (candidate && !out.includes(candidate)) out.push(candidate)
  }
  return out
}

/** 拉取结果（失败带原因，供后台状态显示） */
export type FetchResult =
  | { ok: true; items: RawPrompt[]; usedUrl: string }
  | { ok: false; error: string }

const FETCH_TIMEOUT_MS = 20_000
/** 单源 JSON 体积上限，防误配超大文件把进程打爆 */
const MAX_JSON_BYTES = 20 * 1024 * 1024

/**
 * 拉取一个源并归一化。按镜像候选顺序尝试，第一个成功即返回。
 * 不做 DB 写入 —— 保持纯函数，便于测试与复用。
 */
export async function fetchPromptSource(url: string): Promise<FetchResult> {
  const errors: string[] = []
  for (const candidate of mirrorCandidates(url)) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      let res: Response
      try {
        // safeFetch 逐跳校验重定向，堵住「合法 URL 302 到内网」的 SSRF 绕过
        res = await safeFetch(candidate, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 AigcHubPromptSources/1.0', Accept: 'application/json' },
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        errors.push(hostOf(candidate) + ' HTTP ' + res.status)
        continue
      }
      const text = await res.text()
      if (text.length > MAX_JSON_BYTES) {
        errors.push(hostOf(candidate) + ' 响应过大')
        continue
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        errors.push(hostOf(candidate) + ' 非合法 JSON')
        continue
      }
      const items = normalizePromptItems(data, candidate)
      if (!items.length) {
        errors.push(hostOf(candidate) + ' 无有效条目')
        continue
      }
      return { ok: true, items, usedUrl: candidate }
    } catch (err) {
      errors.push(hostOf(candidate) + ' ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return { ok: false, error: errors.join('；') || '所有镜像均不可达' }
}

/**
 * 把标准 JSON 数组归一成 RawPrompt[]。
 *
 * schema 与 yukkcat/image-prompts 一致：title/prompt 必填，其余可选。
 * 容错原则：脏条目跳过而不是整源失败 —— 一个源里混几条坏数据不该拖垮全部。
 */
export function normalizePromptItems(data: unknown, sourceUrl: string): RawPrompt[] {
  if (!Array.isArray(data)) return []
  const seen = new Set<string>()
  const items: RawPrompt[] = []
  data.forEach((value, index) => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const title = str(record.title).trim()
    const prompt = str(record.prompt).trim()
    if (!title || !prompt) return
    const externalId = str(record.id).trim() || slugOf(sourceUrl) + '-' + String(index + 1).padStart(4, '0')
    if (seen.has(externalId)) return
    seen.add(externalId)
    const coverUrl = absoluteUrl(sourceUrl, str(record.coverUrl))
    items.push({
      externalId,
      title,
      prompt,
      description: str(record.description),
      coverUrl,
      tags: stringArray(record.tags),
      author: str(record.author),
      sourceUrl: absoluteUrl(sourceUrl, str(record.sourceUrl)),
      createdAt: str(record.createdAt),
    })
  })
  return items
}

/** 分类映射：优先用源里的第一个 tag，无则「通用」 */
export function categoryOf(item: RawPrompt, fallback = '通用'): string {
  const tag = item.tags.find((t) => t && t.trim())
  return (tag || fallback).trim().slice(0, 20)
}

/** 从站点源 URL 推断内置源的 key（用于把脚本导入的旧数据挂到源上） */
export function slugOf(url: string): string {
  const m = url.match(/\/sources\/([^/?#]+)\.json/)
  if (m) return m[1]
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || 'source'
    return last.replace(/\.json$/, '')
  } catch {
    return 'source'
  }
}

// ===== 小工具（与开源项目 runtime 同口径，避免各写一份）=====

function str(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(str).map((s) => s.trim()).filter(Boolean)
}

function absoluteUrl(base: string, path: string): string {
  if (!path) return ''
  try {
    return new URL(path, base).toString()
  } catch {
    return path
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 30)
  }
}
