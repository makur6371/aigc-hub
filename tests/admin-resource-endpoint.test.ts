import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 管理面板「资源与接口路径必须匹配」守卫（防回归）
 *
 * 背景（真实 bug，2026-10-03 用户报「供应商怎么关不了了」）：
 *   ApiConfigPanel 的**供应商**表格里，「启用」开关调的是
 *   `/api/admin/models/${r.id}` —— 拿**供应商 id** 去 update **模型**。
 *   两张表 id 各自独立，后果分两种：
 *     1) 找不到 → Prisma P2025 报错，开关点了没反应（生产当时就是这种）；
 *     2) 万一某模型 id 恰好等于该供应商 id → **静默改错模型的启用状态**。
 *   藏得深：编辑/删除/测试都走了正确路径，只有这个开关是复制粘贴漏改的。
 *
 * ⚠️ 写这个守卫踩了两个自己的坑，都记在下面函数注释里：
 *   1) 用正则找「下一个 const」当数组结束标记 → 被内联的 const 提前截断 → 假阴性；
 *   2) 匹配 apiFetch 时跨行 → 跨过注释里的示例路径 → 误报。
 *   两个方向的错都出现过，所以改成括号配平 + 不跨行匹配。
 */

const SRC = join(__dirname, '..', 'src')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n')

/**
 * 用括号配平截出 `const X = [` / `const X = {` 这个字面量。
 * 不能用正则找「下一个 const」—— 数组内部常有内联 const，会被提前截断。
 */
function extractLiteral(src: string, declPrefix: string): string | null {
  const start = src.indexOf(declPrefix)
  if (start < 0) return null
  const iBracket = src.indexOf('[', start)
  const iBrace = src.indexOf('{', start)
  let from = -1
  let openCh = ''
  if (iBracket >= 0 && (iBrace < 0 || iBracket < iBrace)) { from = iBracket; openCh = '[' }
  else if (iBrace >= 0) { from = iBrace; openCh = '{' }
  else return null
  const closeCh = openCh === '[' ? ']' : '}'
  let depth = 0
  let i = from
  let inStr = null
  while (i < src.length) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 2; continue }
    if (ch === openCh) depth++
    else if (ch === closeCh) { depth--; if (depth === 0) return src.slice(from, i + 1) }
    i++
  }
  return null
}

/**
 * 剔除注释，保留字符串字面量。
 *
 * 字符串必须保留：接口路径就写在字符串里，丢了字符串就什么都匹配不到
 * （第一次写反了，resources 变成空数组，守卫对真 bug 完全无感 —— 假阴性）。
 * 注释必须剔除：修复 bug 时特意在注释里留了错误示例路径，
 * 不剔除会把注释当成真实调用（假阳性，守卫永远红着）。
 * 两个方向的错都犯过，所以才写成这样。
 */
function stripNoise(code: string): string {
  let out = ''
  let i = 0
  let inStr = null
  while (i < code.length) {
    const ch = code[i]
    if (inStr) {
      if (ch === '\\') { out += ch + (code[i + 1] ?? ''); i += 2; continue }
      if (ch === inStr) inStr = null
      out += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; i++; continue }
    if (ch === '/' && code[i + 1] === '/') { const nl = code.indexOf('\n', i); i = nl < 0 ? code.length : nl; continue }
    if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i); i = e < 0 ? code.length : e + 2; continue }
    out += ch
    i++
  }
  return out
}

function apiResources(block: string): string[] {
  return [...stripNoise(block).matchAll(/\/api\/admin\/([\w-]+)/g)].map((m) => m[1])
}

describe('管理面板 资源/接口一致性', () => {
  it('ApiConfigPanel：供应商表格只调 providers 接口（本次回归点）', () => {
    const s = read('components/admin/ApiConfigPanel.tsx')
    const block = extractLiteral(s, 'const providerColumns')
    expect(block, '找不到 providerColumns').not.toBeNull()
    // assert 后 TS 仍不能收窄（expect 不改变类型），显式断言
    const bad = apiResources(block!).filter((r) => r !== 'providers')
    expect(
      bad,
      `供应商表格里出现了非 providers 的接口：${bad.join(', ')}\n` +
        '表格行的 id 属于该表格的资源，接口必须同资源 —— 否则改错数据或静默失败。',
    ).toEqual([])
  })

  it('模型表格只调 models 接口（对称检查）', () => {
    const s = read('components/admin/ApiConfigPanel.tsx')
    const block = extractLiteral(s, 'const modelColumns')
    if (!block) return
    const bad = apiResources(block).filter((r) => r !== 'models')
    expect(bad, `模型表格里出现了非 models 的接口：${bad.join(', ')}`).toEqual([])
  })

  it('全 admin 面板接口路径在白名单内（跨资源只读需显式登记）', () => {
    // 允许的跨资源**只读**调用（带明确外键、不改数据），与「id 混用」区分开。
    const READONLY_CROSS: Record<string, string[]> = {
      // 用户详情拉该用户的用量记录（按 userId 过滤，不是拿用户 id 当日志 id）
      'UsersPanel.tsx': ['usage-logs'],
      // 节点配置里选模型时拉模型下拉（只读列表）
      'AgentsNodesPanel.tsx': ['models'],
    }
    const EXPECTED: Record<string, string[]> = {
      'ApiConfigPanel.tsx': ['providers', 'models', 'adapters'],
      'ToolsAdminPanel.tsx': ['tools'],
      'UsersPanel.tsx': ['users'],
      'WorksReviewPanel.tsx': ['works'],
      'PromptsAdminPanel.tsx': ['prompts'],
      'AnnouncementsPanel.tsx': ['announcements'],
      'AgentsNodesPanel.tsx': ['canvas-nodes'],
      'AdapterManager.tsx': ['adapters'],
      'InviteRewardsPanel.tsx': ['invite-rewards', 'invite-policy'],
    }

    const offenders: string[] = []
    for (const [file, baseAllowed] of Object.entries(EXPECTED)) {
      const allowed = [...baseAllowed, ...(READONLY_CROSS[file] ?? [])]
      for (const res of apiResources(read(`components/admin/${file}`))) {
        if (!allowed.includes(res)) {
          offenders.push(`${file}: 调用了 /api/admin/${res}，允许列表 [${allowed.join(', ')}]`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
